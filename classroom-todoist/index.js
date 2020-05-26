const { get: GET, post: POST, delete: DELETE } = require('axios').default;
const { google } = require('googleapis');
const { Timestamp } = require('@google-cloud/firestore');
const { v4: uuid } = require('uuid');

const { db, errors } = require('../google');
const Todoist = require('../todoist');
const {
  authorize,
  formatDate,
  formatDateTime,
  getNewToken,
  snapshotMap,
  ellipsis
} = require('../utils');

// constants
const SCOPES = [
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
  'https://www.googleapis.com/auth/classroom.announcements.readonly',
];
module.exports.SCOPES = SCOPES;
const CLASSES = [
  '49975101864', // calculus
  '50452773557', // history
  '50251943702', // english
];
module.exports.CLASSES = CLASSES;

// authorization
const todoist = new Todoist();
const client = authorize(require('./token.auth.json'));
const classroom = google.classroom({ version: 'v1', auth: client });

/**
 * Add user profile to Google Classroom URL (/u/[profile]/)
 * @param {string} url
 * @param {number} profile
 */
function formatURL(url, profile = 1) {
  return url.replace('classroom.google.com/', `classroom.google.com/u/${profile}/`);
}

async function sync() {
  let res;
  // todoist ids
  const tempIds = {};
  // get class information
  const query = await db.collection('classroom-classes').where('google', 'in', CLASSES).get();
  const courses = await snapshotMap(query, _ => _); // convert to array
  const labels = await todoist.ensureLabels(['homework', 'automation', 'classroom']);

  for (const courseRef of courses) {
    // get course data
    const course = courseRef.data();
    const tasks = course.tasks || {};
    // setup todoist structure
    const [assignmentSection, miscSection] = await todoist.ensureSections(course.todoist, [
      'automation: classroom assignments',
      'automation: classroom misc'
    ]);

    // get classroom data
    res = await classroom.courses.courseWork.list({
      courseId: course.google,
      fields: 'courseWork(id,title,dueDate,dueTime,maxPoints,alternateLink)'
    });
    const work = res.data.courseWork.reduce((acc, curr) => ({ ...acc, [curr.id]: curr }), {});
    res = await classroom.courses.courseWork.studentSubmissions.list({
      courseId: course.google,
      courseWorkId: '-',
      fields: 'studentSubmissions(userId,courseWorkId,state)'
    });
    res.data.studentSubmissions.forEach(sub => {
      Object.assign(work[sub.courseWorkId], sub)
    });

    // promise.all used to let them run concurrently
    await Promise.all(Object.values(work).map(async (assignment) => {
      // generate data format
      const data = {
        google: assignment.id,
        class: course.name,
        link: formatURL(assignment.alternateLink),
        title: assignment.title,
        state: assignment.state || null,
        // ungraded (low) -> graded (mid) -> >10 points (high)
        priority: assignment.maxPoints ? (assignment.maxPoints > 10 ? 4 : 3) : 2,
        dueDate: null,
      };
      if (assignment.dueDate) {
        const { year, month, day } = assignment.dueDate;
        const hours = assignment.dueTime ? assignment.dueTime.hours : 0;
        const minutes = assignment.dueTime ? assignment.dueTime.minutes || 0 : 0;
        data.dueDate = Timestamp.fromDate(new Date(Date.UTC(year, month - 1, day, hours, minutes)));
      }

      // compare with
      const dbId = `${course.name}-${assignment.id}`;
      const old = tasks[assignment.id] || null;
      if (!old) {
        // create task if not exists and not already turned in
        if (data.state !== 'TURNED_IN' && data.state !== 'RETURNED') {
          const args = {
            content: `**Assignment:** [${ellipsis(data.title)}](${data.link})`,
            priority: data.priority,
            project_id: course.todoist,
            labels, section_id: assignmentSection,
          }
          if (data.dueDate) {
            const date = data.dueDate.toDate();
            args.due = { date: data.dueTime ? formatDateTime(date) : formatDate(date) };
          }
          const temp_id = uuid();
          todoist.queue(dbId, { type: 'item_add', temp_id, args });
          tempIds[assignment.id] = temp_id;
        }
      } else {
        const oldId = old.todoist;
        // update task if things have changed
        if (data.state !== old.state) {
          if (oldId) {
            if (data.state === 'TURNED_IN') {
              todoist.queue(dbId, { type: 'item_close', args: { id: oldId } });
            }
            if (data.state === 'RECLAIMED_BY_STUDENT') {
              todoist.queue(dbId, { type: 'item_uncomplete', args: { id: oldId } });
            }
          }
          if (data.state === 'RETURNED') {
            todoist.queue(dbId, {
              type: 'item_add',
              temp_id: uuid(),
              args: {
                content: `**Returned assignment:** [${ellipsis(data.title)}](${data.link})`,
                priority: 4,
                project_id: course.todoist,
                labels, section_id: miscSection,
                due: { string: 'today' },
              }
            });
          }
        }
        if (
          data.title !== old.title ||
          (data.dueDate && old.dueDate && !data.dueDate.isEqual(old.dueDate))
        ) {
          if (oldId) {
            const args = {
              id: oldId,
              content: `**Assignment:** [${ellipsis(data.title)}](${data.link})`,
            }
            if (data.dueDate) {
              const date = data.dueDate.toDate();
              args.due = { date: data.dueTime ? formatDateTime(date) : formatDate(date) };
            }
            todoist.queue(dbId, { type: 'item_update', args });
          }
        }
      }

      // update database
      tasks[assignment.id] = data;
    }));

    // get classroom announcements
    res = await classroom.courses.announcements.list({
      courseId: course.google,
      fields: 'announcements(id,text,alternateLink,updateTime)',
      orderBy: 'updateTime desc'
    });
    const { announcements } = res.data;
    const latest = announcements.length > 0
      ? Timestamp.fromDate(new Date(announcements[0].updateTime))
      : Timestamp.fromMillis(0);
    const last = course.lastAnnouncement ? course.lastAnnouncement : Timestamp.fromMillis(0);

    // update todoist
    if (latest > last) {
      announcements
        .filter(ann => Timestamp.fromDate(new Date(ann.updateTime)) > course.lastAnnouncement)
        .forEach(ann => {
          todoist.queue(`${course.name}-announcement-${ann.id}`, {
            type: 'item_add', temp_id: uuid(), args: {
              content: `**Check announcement:** [${ellipsis(ann.text)}](${formatURL(ann.alternateLink)})`,
              priority: 4,
              project_id: course.todoist,
              labels, section_id: miscSection,
              due: { string: 'today' },
            }
          });
        });
    }

    // update todoist
    res = await todoist.sync();

    // update database
    await courseRef.ref.set({
      ...course,
      tasks: Object.keys(tasks).reduce((prev, id) => {
        if (tempIds[id]) {
          prev[id] = { ...tasks[id], todoist: res.temp_id_mapping[tempIds[id]] };
        } else {
          prev[id] = tasks[id];
        }
        return prev;
      }, {}),
      lastAnnouncement: latest
    });

  }
}

/**
 * Reset tasks and Firebase cache
 */
async function reset() {
  // delete todoist tasks
  const [label] = await todoist.ensureLabels(['classroom']);
  const res = await todoist.get(['items']);
  const tasks = res.items.filter(({ labels }) => labels.includes(label));
  console.log(`Deleting ${tasks.length} tasks...`);
  while (tasks.length) {
    tasks.splice(0, 100).forEach(({ id }) => todoist.queue(id, { type: 'item_delete', args: { id } }));
    await todoist.sync();
  }
  // delete coursework cache
  const snapshot = await db.collection('classroom-classes').orderBy('__name__').get();
  if (snapshot.size > 0) {
    console.log(`Cleaning ${snapshot.size} classes...`);
    const batch = db.batch();
    snapshot.forEach(doc => {
      const now = new Date();
      batch.set(doc.ref, {
        tasks: {},
        // reset announcement to midnight of the current day
        lastAnnouncement: Timestamp.fromDate(new Date(now.getFullYear(), now.getMonth(), now.getDate())),
      }, { merge: true });
    });
    await batch.commit();
  }
}

module.exports.entry = async () => {
  await sync().catch(e => {
    console.error(e);
    errors.report(e);
  });
}

if (require.main === module) {
  if (process.argv[2] === 'token') getNewToken(client, SCOPES);
  else if (process.argv[2] === 'reset') reset().catch(e => console.error(e));
  else sync().catch(e => console.error(e));
}