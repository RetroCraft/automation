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
  ensureTodoistLabels,
  ensureTodoistSection,
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
const todoistAuth = require('./todoist.auth.json');
const headers = {
  headers: { Authorization: `Bearer ${todoistAuth.apiKey}` }
};
const todoist = new Todoist(todoistAuth.apiKey);

const client = authorize(require('./token.auth.json'));
const classroom = google.classroom({ version: 'v1', auth: client });

async function sync() {
  let res;
  // todoist ids
  const tempIds = {};
  // get class information
  const query = await db.collection('classroom-classes').where('google', 'in', CLASSES).get();
  const courses = await snapshotMap(query, _ => _); // convert to array

  for (const courseRef of courses) {
    const course = courseRef.data();
    // setup todoist structure
    const labels = await ensureTodoistLabels(['homework', 'automation', 'classroom'], headers);
    const assignmentSection = await ensureTodoistSection(course.todoist, 'automation: classroom assignments', headers);
    const miscSection = await ensureTodoistSection(course.todoist, 'automation: classroom misc', headers);

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
        link: assignment.alternateLink,
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

      // compare with database
      const dbId = `${course.name}-${assignment.id}`;
      const ref = db.collection('classroom-tasks').doc(dbId);
      const doc = await ref.get();
      if (!doc.exists) {
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
          tempIds[temp_id] = dbId;
        }
      } else {
        const old = doc.data();
        let update = false;
        // update task if things have changed
        if (data.state !== old.state) {
          update = true;
          if (data.state === 'TURNED_IN') {
            todoist.queue(dbId, { type: 'item_close', args: { id: old.todoist } });
          } else if (data.state === 'RECLAIMED_BY_STUDENT') {
            todoist.queue(dbId, { type: 'item_uncomplete', args: { id: old.todoist } });
          } else if (data.state === 'RETURNED') {
            todoist.queue(dbId, {
              type: 'item_add',
              temp_id: uuid(),
              args: {
                content: `**Returned assignment:** [${ellipsis(data.title)}](${data.link})`,
                priority: 4,
                project_id: course.todoist,
                label_ids: labels, section_id: miscSection,
                due: { string: 'today' },
              }
            });
          }
        }
        if (
          data.title !== old.title ||
          (data.dueDate && old.dueDate && !data.dueDate.isEqual(old.dueDate))
        ) {
          update = true;
          const args = {
            id: old.todoist,
            content: `**Assignment:** [${ellipsis(data.title)}](${data.link})`,
          }
          if (data.dueDate) {
            const date = data.dueDate.toDate();
            args.due = { date: data.dueTime ? formatDateTime(date) : formatDate(date) };
          }
          todoist.queue(dbId, { type: 'item_update', args });
        }
        // update database
        if (update) await ref.set(data);
      }
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
      announcements.filter(announcement => Timestamp.fromDate(new Date(announcement.updateTime)) > course.lastAnnouncement)
        .forEach(announcement => {
          todoist.queue(`${course.name}-announcement-${announcement.id}`, {
            type: 'item_add', temp_id: uuid(), args: {
              content: `**Check announcement:** [${ellipsis(announcement.text)}](${announcement.alternateLink})`,
              priority: 4,
              project_id: course.todoist,
              labels, section_id: miscSection,
              due: { string: 'today' },
            }
          });
        });
    }

    // update database
    await courseRef.ref.set({ lastAnnouncement: latest }, { merge: true });
  }

  // update todoist
  res = await todoist.sync();
  for (const [temp, path] of Object.entries(tempIds)) {
    db.collection('classroom-tasks').doc(path).set(
      { todoist: res.temp_id_mapping[temp] },
      { merge: true },
    );
  }
}

async function reset() {
  // delete todoist tasks
  const [label] = await ensureTodoistLabels(['automation'], headers);
  const res = await GET(`https://api.todoist.com/rest/v1/tasks?label_id=${label}`, headers);
  console.log(`Deleting ${res.data.length} tasks...`);
  res.data.forEach(({ id }) => todoist.queue(id, { type: 'item_delete', args: { id } }));
  await todoist.sync();
  // delete coursework cache
  const snapshot = await db.collection('classroom-tasks').orderBy('__name__').get();
  if (snapshot.size > 0) {
    console.log(`Deleting ${snapshot.size} documents...`);
    const batch = db.batch();
    snapshot.forEach(doc => batch.delete(doc.ref));
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