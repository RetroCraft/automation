# Automation

Assorted automation scripts and cloud functions.

Google Cloud Platform service account key required at `keyfile.auth.json` and API credentials at `credentials.auth.json`.

Deploy using `gcloud functions deploy camelCaseName`.
Include `--runtime nodejs14` and `--trigger-topic [minute|half-hour]` on first deploy.

## Scripts

### classroom-todoist

One-way sync from Google Classroom to Todoist.

Requires Todoist API key in `todoist.auth.json` and a Google OAuth token in `token.auth.json` with the right scopes.
Deployed to Google Cloud Functions and attached to Cloud Scheduler on every minute with Pub/Sub.

#### Usage

`node ./classroom-todoist [reset|token]`

If no command specified, sync new Google Classroom assignments and announcements to Todoist.

Run `reset` to delete all Todoist tasks and clear the Firestore cache.
Run `token` and follow instructions to create an OAuth token in the working directory.

### d2l-todoist

One-way sync from D2L to Todoist.

Requires D2L email and password in `d2l.auth.json`.
Deployed to Google Cloud Functions and attached to Cloud Scheduler every half hour with Pub/Sub.

### notion-gcal

One-way sync from Notion to Google Calendar.

Requires Notion API key in `notion.auth.json`.
