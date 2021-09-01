const { db, errors } = require('../google');
const {
  authorize,
  getNewToken,
  log,
} = require('../utils');

// APIs
const { google } = require('googleapis');
const { Timestamp } = require('@google-cloud/firestore');
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events'
];
const client = authorize(require('./token.auth.json'));
const calendar = google.calendar({ version: 'v3', auth: client });

const { Client } = require('@notionhq/client');
const notion = new Client({
  auth: require('./notion.auth.json').token,
});

// Config
const CALENDAR_ID = '7r6l07njfat25g06tjgu95ver8@group.calendar.google.com';
const COURSE_DATABASE_ID = 'f1f6207eba694301b1bb5491b3a63b15';
const DELIVERABLE_DATABASE_ID = 'c4f72eb149884ea5b5eb24b2b681195a';
const ACTIVE_TERM = '2A';
const COURSE_COLORS = {
  'CS 245': '#ff887c',
  'CS 246': '#ffb878',
  'BU 127': '#fbd75b',
  'BU 283': '#7cb342', // (calendar colour)
  'BU 288': '#51b749'
}

async function sync() {
  // load colors
  const eventColors = (await calendar.colors.get()).data.event;
  const ColorMap = {};
  Object.entries(eventColors).map(([i, { background }]) => ColorMap[background] = i);

  // load notion courses
  const courseQuery = await notion.databases.query({
    database_id: COURSE_DATABASE_ID,
    filter: { property: 'Term', select: { equals: ACTIVE_TERM } }
  });
  const CourseMap = {};
  courseQuery.results.forEach((page) => {
    const title = page.properties?.Name?.title?.[0]?.text?.content;
    if (!title) log(`Page ${page.id} has no title`, 'WARN');
    CourseMap[page.id] = title ?? 'Untitled';
  });

  // load cache, which stores { [id: Notion Page ID]: { eventId: string, updated: Timestamp } }
  const doc = db.collection('notion-gcal').doc(ACTIVE_TERM);
  const cache = (await doc.get()).data();

  // load notion
  const deliverableQuery = await notion.databases.query({
    database_id: DELIVERABLE_DATABASE_ID,
    filter: {
      and: [
        {
          property: 'Due Date',
          date: { is_not_empty: true }
        },
        {
          property: 'Term',
          rollup: { any: { select: { equals: ACTIVE_TERM } } }
        },
        {
          property: 'Course',
          relation: { is_not_empty: true }
        }
      ]
    }
  });
  const deliverables = deliverableQuery.results.map((page) => {
    // return only the fields that we care about
    return {
      id: page.id,
      title: page.properties['Name'].title[0].text.content,
      url: page.url,
      updated: Timestamp.fromDate(new Date(page.last_edited_time)),
      course: CourseMap[page.properties['Course'].relation[0].id],
      start: page.properties['Date'].date.start,
      end: page.properties['Date'].date.end
    }
  });

  const toGcalDate = (string) => {
    // YYYY-MM-DD
    if (string.length === 10) return { date: string };
    // YYYY-MM-DDThh:mm:ss.SSSZ
    else return { dateTime: string };
  }

  let updated = false;
  for (const deliverable of deliverables) {
    const cacheEntry = cache[deliverable.id];
    const requestBody = {
      summary: `${deliverable.course} - ${deliverable.title}`,
      source: {
        title: deliverable.title,
        url: deliverable.url,
      }
    };
    // add color
    if (ColorMap?.[COURSE_COLORS?.[deliverable.course]]) requestBody.colorId = ColorMap[COURSE_COLORS[deliverable.course]];
    // add start and end date
    requestBody.start = toGcalDate(deliverable.start);
    requestBody.end = deliverable.end ? toGcalDate(deliverable.end) : requestBody.start;

    if (!cacheEntry) {
      // create new event
      const res = await calendar.events.insert({ calendarId: CALENDAR_ID, requestBody });
      log(`Inserted ${deliverable.course}/${deliverable.title} (${res.data.id})`);

      cache[deliverable.id] = {
        eventId: res.data.id,
        updated: deliverable.updated,
      }
      updated = true;
    } else if (cacheEntry.updated < deliverable.updated) {
      // update existing event
      await calendar.events.patch({
        calendarId: CALENDAR_ID,
        eventId: cacheEntry.eventId,
        requestBody
      });
      log(`Updated ${deliverable.course}/${deliverable.title} (${cacheEntry.eventId})`);

      cache[deliverable.id].updated = deliverable.updated;
      updated = true;
    }
  }

  // process deletions
  for (const pageId of Object.keys(cache)) {
    const deliverable = deliverables.find((x) => x.id === pageId);
    if (!deliverable) {
      const { data } = await calendar.events.get({ calendarId: CALENDAR_ID, eventId: cache[pageId].eventId });

      if (data.status !== 'cancelled') {
        await calendar.events.delete({
          calendarId: CALENDAR_ID,
          eventId: data.id,
        });
        log(`Deleted ${data.summary} (${data.id})`);
      }

      delete cache[data.id];
      updated = true;
    }
  }

  if (updated) await doc.set(cache);
}

async function reset() {
  // clear cache
  const doc = db.collection('notion-gcal').doc(ACTIVE_TERM);
  const cache = (await doc.get()).data();
  // clear calendar
  process.stdout.write(`Deleting ${Object.keys(cache).length} events`);
  for (const { eventId } of Object.values(cache)) {
    process.stdout.write('.');
    try {
      await calendar.events.delete({ calendarId: CALENDAR_ID, eventId });
    } catch (e) {
      // ignore already deleted errors
      if (e.code === 410) continue;
      throw e;
    }
  }
  process.stdout.write('\n');
  // clear cache
  await doc.set({});
}

module.exports.entry = async () => {
  await sync().catch(e => {
    if (process.env.NODE_ENV === 'production') errors.report(e);
    else console.error(e);
  });
}

if (require.main === module) {
  if (process.argv[2] === 'token') getNewToken(client, SCOPES);
  if (process.argv[2] === 'reset') reset().catch(e => console.error(e));
  else sync().catch(e => console.error(e));
}
