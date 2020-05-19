const { post } = require('axios').default;
const { v4: uuid } = require('uuid');

const { errors } = require('./google');

class Todoist {

  constructor(token) {
    this.token = token;
    this.sync_token = '*';
    this.commands = [];
    this.commandNames = {};
  }

  queue(name, command) {
    const taskUuid = uuid();
    this.commandNames[taskUuid] = `${name}/${command.type}`;
    console.log(`[${name}/${command.type}] Todoist sync queued`);
    this.commands.push(Object.assign(command, { uuid: taskUuid }));
  }

  async sync() {
    console.log(`Running ${this.commands.length} todoist commands...`);
    const res = await post('https://api.todoist.com/sync/v8/sync', {
      token: this.token,
      sync_token: this.sync_token,
      commands: this.commands,
    });
    // reset state
    this.sync_token = res.data.sync_token;
    this.commands = [];
    // check command status
    if (res.data.sync_status) {
      for (const [id, status] of Object.entries(res.data.sync_status)) {
        const name = this.commandNames[id];
        if (status === 'ok') {
          console.log(`[${name}] Todoist sync ok`);
        } else {
          console.error(`[${name}] Todoist sync error ${status.error_code}: ${status.error}`);
          errors.report(`[${name}] Todoist sync error ${status.error_code}: ${status.error}`);
        }
      }
    }
    return res.data;
  }

}
module.exports = Todoist;