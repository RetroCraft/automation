const { get: GET } = require('axios').default;
const cheerio = require('cheerio');
const { Timestamp } = require('@google-cloud/firestore');
const Turndown = require('turndown');
const puppeteer = require('puppeteer');
const { v4: uuid } = require('uuid');

const { db } = require('../google');
const Todoist = require('../todoist');
const { ellipsis, snapshotMap } = require('../utils');

const CLASSES = ['14331112']; // physics

const todoist = new Todoist();
const auth = require('./d2l.auth.json');
const turndown = new Turndown();
const md = turndown.turndown.bind(turndown);

/**
 * Login to D2L
 * @returns {string} JWT token
 */
async function login() {
  const ref = db.collection('automation').doc('d2l');
  cache = (await ref.get()).data();
  if (!cache || !cache.cookie || cache.cookieExpire < Timestamp.now()) {
    const browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();
    await page.goto('https://pdsb.elearningontario.ca/d2l/home');
    const email = await page.waitForSelector('[aria-label^="Enter your email"]');
    await email.type(auth.email);
    await page.$('[value="Next"]').then(_ => _.click());
    const password = await page.waitForSelector('[type=password]:not(.moveOffScreen)');
    await password.type(auth.password);
    await page.$('[value="Sign in"]').then(_ => _.click());
    await page.waitForSelector('[value="No"]').then(_ => _.click());
    const res = await page.waitForResponse('https://pdsb.elearningontario.ca/d2l/lp/auth/oauth2/token');
    const token = await res.json();
    const { cookies } = await page._client.send('Network.getAllCookies');
    browser.close();
    cache = {
      ...cache,
      cookie: `d2lSessionVal=${cookies.find(_ => _.name === 'd2lSessionVal').value}; d2lSecureSessionVal=${cookies.find(_ => _.name === 'd2lSecureSessionVal').value}`,
      key: token.access_token,
      keyExpire: Timestamp.fromMillis(token.expires_at * 1000)
    };
  }
  if (!cache.key || cache.keyExpire < Timestamp.now()) {
    const res = await GET('https://pdsb.elearningontario.ca/d2l/lp/auth/oauth2/token', {
      headers: {
        cookie: cache.cookie
      }
    });
    cache.key = res.data.access_token;
    cache.keyExpire = Timestamp.fromMillis(token.expires_at * 1000);
  }
  cache.cookieExpire = new Date(Date.now() + 180 * 60 * 1000); // expire after 180 mins
  await ref.set(cache);
  return cache;
}

async function sync() {
  let res;
  const auth = await login();
  const headers = {
    Authorization: 'Bearer ' + auth.key,
    Cookie: auth.cookie,
    'User-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Brave Chrome/81.0.4044.138 Safari/537.36'
  };
  const labels = await todoist.ensureLabels(['homework', 'automation', 'd2l']);
  // get class information
  const query = await db.collection('d2l-classes').where('d2l', 'in', CLASSES).get();
  const courses = await snapshotMap(query, _ => _); // convert to array

  for (const courseRef of courses) {
    let update = false;
    const course = courseRef.data();
    // setup todoist structure
    const assignmentSection = await todoist.ensureSection(course.todoist, 'automation: d2l assignments');
    const miscSection = await todoist.ensureSection(course.todoist, 'automation: d2l misc');

    // latest posts
    res = await GET(`https://prd.activityfeed.ca-central-1.brightspace.com/api/v1/d2l:orgUnit:${course.d2l}/article`, { headers });
    const announcements = res.data.orderedItems.map(({ object, published }) => {
      const data = {
        ...object,
        updated: Timestamp.fromDate(new Date(object.updated ? object.updated : published)),
        // only take text from the first paragraph
        text: md(object.content.match(/^<p>(.+?)<\/p>/m)[1]),
      }
      // find link if it exists
      if (object.attachments) {
        const link = object.attachments.find(a => a.url && a.url[0] && a.url[0].type === 'Link');
        if (link) data.link = link.url[0].href;
      }
      return data;
    });
    const latest = announcements.length > 0
      ? announcements[0].updated
      : Timestamp.fromMillis(0);
    const last = course.lastAnnouncement ? course.lastAnnouncement : Timestamp.fromMillis(0);
    if (latest > last) {
      announcements
        .filter(ann => ann.updated > last)
        .forEach((ann, i) => {
          update = true;
          let content = ellipsis(ann.text);
          if (ann.link) content += ` [attachment](${ann.link})`;
          todoist.queue(i, {
            type: 'item_add', temp_id: uuid(), args: {
              content: `**Check announcement:** ${content}`,
              priority: 4,
              project_id: course.todoist,
              labels, section_id: miscSection,
              due: { string: 'today' },
            }
          });
        });
    }
    course.lastAnnouncement = latest;

    // assignments
    const assignmentsURL = `https://pdsb.elearningontario.ca/d2l/lms/dropbox/user/folders_list.d2l?ou=${course.d2l}&d2l_stateScopes=%7B1%3A%5B%27gridpagenum%27,%27search%27,%27pagenum%27%5D,2%3A%5B%27lcs%27%5D,3%3A%5B%27grid%27,%27pagesize%27,%27htmleditor%27,%27hpg%27%5D%7D&d2l_stateGroups=%5B%27grid%27,%27gridpagenum%27%5D&d2l_statePageId=353&d2l_state_grid=%7B%27Name%27%3A%27grid%27,%27Controls%27%3A%5B%7B%27ControlId%27%3A%7B%27ID%27%3A%27grid_main%27%7D,%27StateType%27%3A%27%27,%27Key%27%3A%27%27,%27Name%27%3A%27gridFolders%27,%27State%27%3A%7B%27PageSize%27%3A%27200%27,%27SortField%27%3A%27DropboxId%27,%27SortDir%27%3A0%7D%7D%5D%7D&d2l_state_gridpagenum=%7B%27Name%27%3A%27gridpagenum%27,%27Controls%27%3A%5B%7B%27ControlId%27%3A%7B%27ID%27%3A%27grid_main%27%7D,%27StateType%27%3A%27pagenum%27,%27Key%27%3A%27%27,%27Name%27%3A%27gridFolders%27,%27State%27%3A%7B%27PageNum%27%3A1%7D%7D%5D%7D&d2l_change=0`
    res = await GET(assignmentsURL, { headers });
    const $ = cheerio.load(res.data);
    const $assignments = $('.d2l-foldername a');
    const assignments = [];
    for (let i = 0; i < $assignments.length; i++) {
      const $assignment = $($assignments[i]);
      assignments.push($assignment.text());
    }

    if (!course.assignments) course.assignments = [];
    assignments.forEach((assignment, i) => {
      if (!course.assignments.includes(assignment)) {
        update = true;
        course.assignments.push(assignment);
        todoist.queue(i, {
          type: 'item_add', temp_id: uuid(), args: {
            content: `**Assignment:** ${assignment}`,
            priority: 2,
            project_id: course.todoist,
            labels, section_id: assignmentSection,
            due: { string: 'today' },
          }
        });
      }
    });

    if (update) await courseRef.ref.set(course);
  }

  await todoist.sync();
}

/**
 * Reset tasks and cache
 */
async function reset() {
  // delete todoist tasks
  const [label] = await todoist.ensureLabels(['d2l']);
  const res = await todoist.get(['items']);
  const tasks = res.items.filter(({ labels }) => labels.includes(label));
  console.log(`Deleting ${tasks.length} tasks...`);
  tasks.forEach(({ id }) => todoist.queue(id, { type: 'item_delete', args: { id } }));
  await todoist.sync();
  // reset cache
  const snapshot = await db.collection('d2l-classes').orderBy('__name__').get();
  if (snapshot.size > 0) {
    console.log(`Cleaning ${snapshot.size} documents...`);
    await snapshotMap(snapshot, ({ ref }) =>
      ref.set({ lastAnnouncement: Timestamp.fromMillis(0), assignments: [] }, { merge: true }));
  }
}

module.exports.entry = async () => {
  await sync().catch(e => {
    console.error(e);
    errors.report(e);
  });
}

if (require.main === module) {
  if (process.argv[2] === 'reset') reset().catch(e => console.error(e));
  else sync().catch(e => console.error(e));
}