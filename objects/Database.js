import { JsonDB, Config } from 'node-json-db';

import Logger from '../config/modules/logger.js';

class Database {
  constructor() {
    this.db = new JsonDB(new Config('./db/Database.json', true, true, '/'));

    this.translations = {};

    this.timers = {
      write: { id: null, timeout: 2500 },
    };
  }

  /** **********************************************************************************************
   **                                           Getters                                           **
   ********************************************************************************************** */

  getInfos() {
    return `DATABASE`;
  }

  /** **********************************************************************************************
   **                                         Translations                                        **
   ********************************************************************************************** */

  getTranslations(langage) {
    this.translations[langage] ||= {};

    return { ...this.translations[langage] };
  }

  addTranslation(langage, file, uuid, value) {
    this.translations[langage][file] ||= {};
    this.translations[langage][file][uuid] = value;

    this.startWriteTimeout();
  }

  addTranslations(langage, translations) {
    this.translations[langage] ||= {};

    Object.keys(translations).forEach((file) => {
      Object.entries(translations[file]).forEach(([uuid, value]) => {
        this.addTranslation(langage, file, uuid, value);
      });
    });

    this.startWriteTimeout();
  }

  readTranslations() {
    return this.db
      .getData('/translations')
      .then((translations) => {
        this.translations = translations;
      })
      .catch(() => {
        Logger.error(`${this.getInfos()} - READ_TRANSLATIONS`);
      });
  }

  /** **********************************************************************************************
   **                                        Timeout: write                                       **
   ********************************************************************************************** */

  onWriteTimeout() {
    this.db
      .push('/translations', this.translations)
      .then(() => {
        Logger.info(`${this.getInfos()} - WRITE_TRANSLATIONS`);
      })
      .catch((err) => {
        Logger.fatal(`${this.getInfos()} - WRITE_TRANSLATIONS`, err);
      });
  }

  stopWriteTimeout() {
    clearInterval(this.timers.write.id);

    this.timers.write.id = null;
  }

  startWriteTimeout() {
    this.stopWriteTimeout();

    this.timers.write.id = setTimeout(() => {
      this.onWriteTimeout();
    }, this.timers.write.timeout);
  }

  /** **********************************************************************************************
   **                                            Init                                             **
   ********************************************************************************************** */

  initDatabase() {
    return this.db
      .load()
      .then(() => {
        Logger.info(`${this.getInfos()} - INIT_DATABASE`);
      })
      .catch((err) => {
        Logger.fatal(`${this.getInfos()} - INIT_DATABASE`, err);
      });
  }

  async init() {
    await this.initDatabase();

    await this.readTranslations();

    Logger.info(`${this.getInfos()} - INIT`);
  }
}

export default new Database();
