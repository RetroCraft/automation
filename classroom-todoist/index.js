const { get, post } = require('axios').default;
const { google } = require('googleapis');
const { ErrorReporting } = require('@google-cloud/error-reporting');
const { Firestore, Timestamp } = require('@google-cloud/firestore');

const {
  authorize,
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
const todoist = require('./todoist.auth.json');
const headers = {
  headers: { Authorization: `Bearer ${todoist.apiKey}` }
};

const client = authorize(require('./token.auth.json'));
const classroom = google.classroom({ version: 'v1', auth: client });

const keyfile = require('../keyfile.auth.json');
const googleSettings = {
  projectId: 'random-api-things',
  credentials: {
    client_email: keyfile.client_email,
    private_key: keyfile.private_key
  },
};
const db = new Firestore(googleSettings);
const errors = new ErrorReporting(googleSettings);

async function sync() {
  let res;
  // get class information
  const query = await db.collection('classroom-classes').where('google', 'in', CLASSES).get();
  const courses = await snapshotMap(query, _ => _); // convert to array

  for (const courseRef of courses) {
    const course = courseRef.data();
    // setup todoist structure
    const label_ids = await ensureTodoistLabels(['homework', 'automation'], headers);
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
    })
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
      }
      if (assignment.dueDate) {
        const { year, month, day } = assignment.dueDate;
        const hours = assignment.dueTime ? assignment.dueTime.hours : 0;
        const minutes = assignment.dueTime ? assignment.dueTime.minutes || 0 : 0;
        const dueDate = Timestamp.fromDate(new Date(Date.UTC(year, month - 1, day, hours, minutes)));
        Object.assign(data, { dueDate });
      }

      // compare with database
      const ref = db.collection('classroom-tasks').doc(`${course.name}-${assignment.id}`);
      const doc = await ref.get();
      if (!doc.exists) {
        // create task if not exists and not already turned in
        if (data.state !== 'TURNED_IN' && data.state !== 'RETURNED') {
          const postData = {
            content: `**Assignment:** [${ellipsis(data.title)}](${data.link})`,
            priority: data.priority,
            project_id: course.todoist,
            label_ids, section_id: assignmentSection,
          }
          if (data.dueDate) {
            postData.due_datetime = data.dueDate.toDate().toISOString()
          }
          res = await post('https://api.todoist.com/rest/v1/tasks', postData, headers)
          Object.assign(data, { todoist: res.data.id });
        }
      } else {
        const old = doc.data();
        // update task if things have changed
        if (data.state !== old.state) {
          if (data.state === 'TURNED_IN') {
            await post(`https://api.todoist.com/rest/v1/tasks/${old.todoist}/close`, {}, headers);
          } else if (data.state === 'RECLAIMED_BY_STUDENT') {
            await post(`https://api.todoist.com/rest/v1/tasks/${old.todoist}/reopen`, {}, headers);
          } else if (data.state === 'RETURNED') {
            await post('https://api.todoist.com/rest/v1/tasks', {
              content: `**Returned assignment:** [${ellipsis(data.title)}](${data.link})`,
              priority: 1,
              project_id: course.todoist,
              label_ids, section_id: miscSection,
              due_string: 'today',
            }, headers)
          }
        }
        if (
          data.title !== old.title ||
          (data.dueDate && old.dueDate && !data.dueDate.isEqual(old.dueDate))
        ) {
          await post(`https://api.todoist.com/rest/v1/tasks/${old.todoist}`, {
            content: `**Assignment:** [${ellipsis(data.title)}](${data.link})`,
            due_datetime: data.dueDate.toDate().toISOString(),
          }, headers)
        }
      }

      // update database
      await ref.set(data);
    }));

    // get classroom announcements
    res = await classroom.courses.announcements.list({
      courseId: course.google,
      fields: 'announcements(text,alternateLink,updateTime)',
      orderBy: 'updateTime desc'
    });
    const { announcements } = res.data;
    const lastAnnouncement = announcements.length > 0
      ? Timestamp.fromDate(new Date(announcements[0].updateTime))
      : Timestamp.fromMillis(0);

    // setup for announcements
    if (!course.lastAnnouncement) {
      await db.collection('classroom-classes').doc(courseRef.id).set({
        lastAnnouncement
      }, { merge: true })
    }

    // update todoist
    if (lastAnnouncement > course.lastAnnouncement) {
      await Promise.all(announcements
        .filter(announcement => Timestamp.fromDate(new Date(announcement.updateTime)) > course.lastAnnouncement)
        .map(async (announcement) => {
          await post('https://api.todoist.com/rest/v1/tasks', {
            content: `**Check announcement:** [${ellipsis(announcement.text)}](${announcement.alternateLink})`,
            priority: 1,
            project_id: course.todoist,
            label_ids, section_id: miscSection,
            due_string: 'today',
          }, headers)
        }));
    }
  }
}

module.exports.entry = async () => {
  await sync().catch(e => {
    console.error(e);
    errors.report(e);
  });
}

if (require.main === module) {
  // getNewToken(client, SCOPES);
  sync().catch(e => console.error(e));
}