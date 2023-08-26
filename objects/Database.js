/* eslint-disable no-restricted-syntax */

import Decimal from 'decimal.js';

import Database from 'better-sqlite3';

import Logger from '../config/logger.js';

class DatabaseInterface {
  constructor() {
    this.ratios = {};

    this.translations = {};

    this.timers = {
      write: { id: null, interval: 30000 },
    };
  }

  /** **********************************************************************************************
   **                                           Getters                                           **
   ********************************************************************************************** */

  getInfos() {
    return `DATABASE`;
  }

  getRatioLength(origin, type) {
    return new Decimal(origin)
      .toNearest(type !== 'words' && origin > 100 ? 100 : 10, Decimal.ROUND_UP)
      .toNumber();
  }

  getRatio(origin, type) {
    const length = this.getRatioLength(origin, type);

    this.ratios[type] ||= {};

    return this.ratios[type][length] || 1;
  }

  /** **********************************************************************************************
   **                                           Setters                                           **
   ********************************************************************************************** */

  setHash(hash) {
    this.hash = hash;
  }

  setUser(user) {
    this.user = user;
  }

  setSource(source) {
    this.source = source;
  }

  setDestination(destination) {
    this.destination = destination;
  }

  /** **********************************************************************************************
   **                                           Helpers                                           **
   ********************************************************************************************** */

  hasTranslation(file, uuid) {
    this.translations[file] ||= {};

    return this.translations[file][uuid] !== undefined;
  }

  /** **********************************************************************************************
   **                                       Database: Ratios                                      **
   ********************************************************************************************** */

  setRatio(type, length, ratio) {
    this.ratios[type] ||= {};
    this.ratios[type][length] = ratio;
  }

  manageRatio(origin, translation, type) {
    const ratio = origin / translation;
    const length = this.getRatioLength(origin, type);

    this.ratios[type] ||= {};
    this.ratios[type][length] ||= ratio;
    this.ratios[type][length] = (99 * this.ratios[type][length] + ratio) / 100;
  }

  readRatios() {
    const ratios = this.db
      .prepare('SELECT * FROM Ratios WHERE source = ? AND destination = ?')
      .all(this.source, this.destination);

    ratios.forEach((el) => this.setRatio(el.type, el.length, el.ratio));
  }

  writeRatios() {
    const stmt = this.db.prepare(`
        INSERT INTO Ratios (source, destination, type, length, ratio)
        VALUES (?, ?, ?, ?, ?)
    `);

    for (const [type, units] of Object.entries(this.ratios)) {
      for (const [unit, ratio] of Object.entries(units)) {
        stmt.run(this.source, this.destination, type, unit, ratio);
      }
    }

    Logger.info(`${this.getInfos()} - WRITE_RATIOS`);
  }

  /** **********************************************************************************************
   **                                   Database: Translations                                    **
   ********************************************************************************************** */

  setTranslation(file, uuid, text) {
    this.translations[file] ||= {};
    this.translations[file][uuid] = text;
  }

  readTranslations() {
    const translations = this.db
      .prepare(
        `SELECT * FROM Translations 
        WHERE user = ? AND source = ? AND destination = ? AND hash = ?`
      )
      .all(this.user, this.source, this.destination, this.hash);

    translations.forEach((el) => this.setTranslation(el.file, el.uuid, el.text));
  }

  writeTranslations() {
    const stmt = this.db.prepare(`
        INSERT INTO Translations 
        (user, source, destination, hash, file, uuid, text)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const [file, uuids] of Object.entries(this.translations)) {
      for (const [uuid, text] of Object.entries(uuids)) {
        stmt.run(this.user, this.source, this.destination, this.hash, file, uuid, text);
      }
    }

    Logger.info(`${this.getInfos()} - WRITE_TRANSLATIONS`);
  }

  /** **********************************************************************************************
   **                                        Timeout: write                                       **
   ********************************************************************************************** */

  stopWriteInterval() {
    clearInterval(this.timers.write.id);

    this.timers.write.id = null;
  }

  startWriteInterval() {
    this.stopWriteInterval();

    this.timers.write.id = setInterval(() => {
      this.writeRatios();
      this.writeTranslations();
    }, this.timers.write.interval);
  }

  /** **********************************************************************************************
   **                                            Exit                                             **
   ********************************************************************************************** */

  exit() {
    this.writeRatios();
    this.writeTranslations();

    setInterval(() => {
      process.exit(0);
    }, 1000);
  }

  /** **********************************************************************************************
   **                                            Init                                             **
   ********************************************************************************************** */

  initTableRatios() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS Ratios (
          id INTEGER PRIMARY KEY,
          source TEXT NOT NULL,
          destination TEXT NOT NULL,
          type TEXT NOT NULL,
          length INTEGER NOT NULL,
          ratio REAL NOT NULL
      );
    `);
  }

  initTableTranslations() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS Translations (
          id INTEGER PRIMARY KEY,
          user TEXT NOT NULL,
          source TEXT NOT NULL,
          destination TEXT NOT NULL,
          hash TEXT NOT NULL,
          file TEXT NOT NULL,
          uuid TEXT NOT NULL,
          text TEXT NOT NULL
      );
    `);
  }

  initDatabase() {
    try {
      this.db = new Database('./db/Database.db');

      this.initTableRatios();
      this.initTableTranslations();

      Logger.info(`${this.getInfos()} - INIT_DATABASE`);
    } catch (err) {
      Logger.error(`${this.getInfos()} - INIT_DATABASE`, err);
    }
  }

  async init() {
    await this.initDatabase();

    this.startWriteInterval();

    Logger.info(`${this.getInfos()} - INIT`);
  }
}

export default new DatabaseInterface();
