
const { ErrorReporting } = require('@google-cloud/error-reporting');
const { Firestore } = require('@google-cloud/firestore');

const keyfile = require('./keyfile.auth.json');
const googleSettings = {
  projectId: 'random-api-things',
  credentials: {
    client_email: keyfile.client_email,
    private_key: keyfile.private_key
  },
};
module.exports.db = new Firestore(googleSettings);
module.exports.errors = new ErrorReporting(googleSettings);
