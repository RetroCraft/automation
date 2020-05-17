const fs = require('fs');
const readline = require('readline');

const axios = require('axios');
const { get, post } = axios.default;
const { google } = require('googleapis');

/**
 * Truncate `str` at `len` with ending `end`.
 * @param {string} str String to truncate
 * @param {number} len Optimal length of string
 * @param {string} end Tag onto end of string
 */
module.exports.ellipsis = (str, len = 50, end = '...') => {
  if (str.length <= len) return str;
  const re = new RegExp(`^.{${len}}(\\w+)?`);
  const match = re.exec(str);
  return match[0] + end;
}

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
}

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

/**
 * Get Todoist label IDs by name, creating if they does not exist
 * @param {string[]} labels Label names
 * @param {axios.AxiosRequestConfig} headers Axios config containing API key
 * @returns {Promise<number>}
 */
module.exports.ensureTodoistLabels = async (labels, headers) => {
  let res = await get('https://api.todoist.com/rest/v1/labels', headers);
  return Promise.all(labels.map(async (name) => {
    const label = res.data.find(l => l.name === name);
    if (label) {
      return label.id;
    } else {
      res = await post('https://api.todoist.com/rest/v1/labels', { name }, headers);
      return res.data.id;
    }
  }))
}

/**
 * Get Todoist section ID by project ID and name, creating if it does not exist
 * @param {number} project_id Project ID
 * @param {string} name Section name
 * @param {axios.AxiosRequestConfig} headers Axios config containing API key
 * @returns {Promise<number>}
 */
module.exports.ensureTodoistSection = async (project_id, name, headers) => {
  let res = await get('https://api.todoist.com/rest/v1/sections', headers);
  const section = res.data.find(sec => (sec.project_id === project_id && sec.name === name));
  if (section) {
    return section.id;
  } else {
    res = await post('https://api.todoist.com/rest/v1/sections', { project_id, name }, headers);
    return res.data.id;
  }
}