# Automation

Assorted automation scripts and cloud functions.

Google Cloud Platform service account key required at `keyfile.auth.json` and API credentials at `credentials.auth.json`.

## Scripts

### classroom-todoist

One-way sync between Google Classroom and Todoist.

Requires Todoist API key in `todoist.auth.json` and a Google OAuth token in `token.auth.json` with the right scopes.
Deployed to Google Cloud Functions and attached to Cloud Scheduler on every minute with Pub/Sub.
