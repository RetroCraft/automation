const { post } = require('axios').default;
const { v4: uuid } = require('uuid');

const { errors } = require('./google');
const auth = require('./todoist.auth.json');

class Todoist {

  constructor() {
    this.token = auth.apiKey;
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

  async get(resources) {
    console.log(`Fetching ${resources.join(', ')} from todoist...`);
    const res = await post('https://api.todoist.com/sync/v8/sync', {
      token: this.token,
      sync_token: '*',
      resource_types: JSON.stringify(resources),
    });
    this.sync_token = res.data.sync_token;
    return res.data;
  }

  async sync() {
    console.log(`Running ${this.commands.length} todoist commands...`);
    const res = await post('https://api.todoist.com/sync/v8/sync', {
      token: this.token,
      sync_token: this.sync_token,
      commands: JSON.stringify(this.commands)
    });
    // check command status
    if (res.data.sync_status) {
      for (const [id, status] of Object.entries(res.data.sync_status)) {
        const name = this.commandNames[id];
        if (status === 'ok') {
          console.log(`[${name}] Todoist sync ok`);
        } else {
          let errString = `[${name}] Todoist sync error ${status.error_code}: ${status.error}`;
          errString += `\n${JSON.stringify(this.commands.find(c => c.uuid === id))}`;
          console.error(errString);
          errors.report(errString);
        }
      }
    }
    // reset state
    this.sync_token = res.data.sync_token;
    this.commands = [];
    return res.data;
  }

  /**
   * Get Todoist label IDs by name, queueing creation if they do not exist
   * @param {string[]} names Label names
   * @returns {Promise<(number|string)[]>}
   */
  async ensureLabels(names) {
    const { labels } = await this.get(['labels']);
    const ids = names.map((name, i) => {
      const label = labels.find(l => l.name === name);
      if (label) {
        return label.id;
      } else {
        const temp_id = uuid();
        this.queue(name, { type: 'label_add', temp_id, args: { name } });
        return temp_id;
      }
    });
    return ids;
  }

  /**
   * Get Todoist section ID by project ID and name, queueing creation if it does not exist
   * @param {number} project_id Project ID
   * @param {string[]} names Section names
   * @returns {Promise<(number|string)[]>}
   */
  async ensureSections(project_id, names) {
    const { sections } = await this.get(['sections']);
    const proj = sections.filter(sec => sec.project_id === project_id);
    return names.map(name => {
      const section = proj.find(sec => sec.name === name);
      if (section) {
        return section.id;
      } else {
        const temp_id = uuid();
        this.queue(name, { type: 'section_add', temp_id, args: { project_id, name } });
        return temp_id;
      }
    });
  }

}

module.exports = Todoist;
