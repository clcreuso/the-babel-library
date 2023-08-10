import Decimal from 'decimal.js';

import { JsonDB, Config } from 'node-json-db';

import Logger from '../config/modules/logger.js';

class Database {
  constructor() {
    this.db = new JsonDB(new Config('./db/Database.json', true, true, '/'));

    this.ratios = {};

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
        this.translations = translations || {};
      })
      .catch(() => {
        Logger.error(`${this.getInfos()} - READ_TRANSLATIONS`);
      });
  }

  /** **********************************************************************************************
   **                                         Translations                                        **
   ********************************************************************************************** */

  getRatioKey(origin, type) {
    return new Decimal(origin)
      .toNearest(type !== 'words' && origin > 100 ? 100 : 10, Decimal.ROUND_UP)
      .toNumber();
  }

  getRatio(origin, type) {
    this.ratios[type] ||= {};

    const key = this.getRatioKey(origin, type);

    if (this.ratios[type][key]) return this.ratios[type][key];

    return type === 'words' ? 0.9 : 0.85;
  }

  addRatio(origin, translation, type) {
    this.ratios[type] ||= {};

    const ratio = origin / translation;
    const key = this.getRatioKey(origin, type);

    this.ratios[type][key] ||= type === 'words' ? 0.9 : 0.85;
    this.ratios[type][key] = (99 * this.ratios[type][key] + ratio) / 100;

    this.startWriteTimeout();
  }

  readRatios() {
    return this.db
      .getData('/ratios')
      .then((ratios) => {
        this.ratios = ratios || {};
      })
      .catch(() => {
        Logger.error(`${this.getInfos()} - READ_RATIOS`);
      });
  }

  /** **********************************************************************************************
   **                                        Timeout: write                                       **
   ********************************************************************************************** */

  writeRatiosTimeout() {
    this.db
      .push('/ratios', this.ratios)
      .then(() => {
        Logger.info(`${this.getInfos()} - WRITE_RATIOS`);
      })
      .catch((err) => {
        Logger.fatal(`${this.getInfos()} - WRITE_RATIOS`, err);
      });
  }

  writeTranslationsTimeout() {
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
      this.writeRatiosTimeout();
      this.writeTranslationsTimeout();
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

    await this.readRatios();
    await this.readTranslations();

    Logger.info(`${this.getInfos()} - INIT`);
  }
}

export default new Database();
