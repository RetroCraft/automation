const fs = require('fs');
const readline = require('readline');

const axios = require('axios');
const { get, post } = axios.default;
const { google } = require('googleapis');

/**
 * Truncate the first line of `str` at `len` with ending `end`.
 * @param {string} str String to truncate
 * @param {number} len Optimal length of string
 * @param {string} end Tag onto end of string
 */
module.exports.ellipsis = (str, len = 50, end = '...') => {
  const lines = str.split('\n');
  if (str.length <= len && lines.length === 1) return str;
  if (lines[0].length <= len) return lines[0] + end;
  const re = new RegExp(`^.{${len}}(\\w+)?`);
  const match = re.exec(lines[0]);
  return match[0] + end;
};

const pad = num => String(num).padStart(2, '0');
/**
 * Format Todoist-acceptable YYYY-MM-DD
 * @param {Date} date
 */
const formatDate = (date) => {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
module.exports.formatDate = formatDate;
/**
 * Format Todoist-acceptable YYYY-MM-DDTHH:MM:SS
 * @param {Date} date
 */
module.exports.formatDateTime = (date) =>
  `${formatDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 * @param {object} token token.auth.json
 */
module.exports.authorize = (token) => {
  const { client_secret, client_id, redirect_uris } = require('./credentials.auth.json').installed;
  const oAuth2Client = new google.auth.OAuth2(
    client_id, client_secret, redirect_uris[0]);
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
};

/**
 * Get and store new token after prompting for user authorization, and then
 * execute the given callback with the authorized OAuth2 client.
 * @param {google.auth.OAuth2} oAuth2Client The OAuth2 client to get token for.
 * @param {string[]} scopes Requested scopes
 */
module.exports.getNewToken = (oAuth2Client, scopes) => new Promise((resolve, reject) => {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
  });
  console.log('Authorize this app by visiting this url:', authUrl);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question('Enter the code from that page here: ', (code) => {
    rl.close();
    oAuth2Client.getToken(code, (err, token) => {
      if (err) return reject('Error retrieving access token', err);
      oAuth2Client.setCredentials(token);
      // Store the token to disk for later program executions
      fs.writeFile('token.auth.json', JSON.stringify(token), (err) => {
        if (err) return reject(err);
        console.log('Token stored to token.auth.json');
      });
      resolve(oAuth2Client);
    });
  });
});

/**
 * Asynchronously enumerate children of `snapshot`
 * @param {FirebaseFirestore.DocumentSnapshot} snapshot
 * @param {Function} callback
 * @returns {Promise<Array>} Array of results of callback
 */
module.exports.snapshotMap = (snapshot, callback) => {
  const promises = [];
  snapshot.forEach((child) => {
    promises.push(callback(child));
  });
  return Promise.all(promises);
};
