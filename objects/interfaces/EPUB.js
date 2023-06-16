/* eslint-disable max-len */

import _ from 'lodash';
import fs from 'fs';
import zip from 'archiver';
import EPUB from 'epub';
import dotenv from 'dotenv';
import crypto from 'crypto';
import iso6391 from 'iso-639-1';
import prettier from 'prettier';

import { JSDOM } from 'jsdom';
import { isWithinTokenLimit } from 'gpt-tokenizer';
import { EventEmitter } from 'events';
import { Configuration, OpenAIApi } from 'openai';

import Database from '../Database.js';

import Logger from '../../config/modules/logger.js';

dotenv.config();

const OpenAI = new OpenAIApi(
  new Configuration({ organization: process.env.OPEN_AI_ORG, apiKey: process.env.OPEN_AI_KEY })
);

export default class EpubInterface extends EventEmitter {
  constructor(params) {
    super();

    this.files = {};

    this.path = params.path;

    this.translations = {
      source: params.source || 'English',
      destination: params.destination || 'English',
      files: {},
    };

    this.timers = {
      queries: { id: null, interval: 2000 },
    };
  }

  /** **********************************************************************************************
   **                                           Getters                                           **
   ********************************************************************************************** */

  getInfos() {
    return `EPUB (${this.getFilename()})`;
  }

  getStatus() {
    return `EPUB (${this.getFilename()}) - STATUS ${
      _.filter(this.queries, (query) => query.finish).length
    }/${this.queries.length}`;
  }

  getIsoCode(language) {
    const code = iso6391.getCode(language);

    return code ? code.toLowerCase() : null;
  }

  getFilename(type = 'source') {
    const lang = type === 'source' ? this.translations.source : this.translations.destination;

    return `${this.epub.metadata.title} - ${this.epub.metadata.creator} (${this.getIsoCode(lang)})`;
  }

  getFileUUID() {
    const fileContent = fs.readFileSync(this.path);

    return crypto.createHash('md5').update(fileContent).digest('hex');
  }

  getRootPath() {
    return `./tmp/${this.getFileUUID()}`;
  }

  getFilePath(path) {
    return `${this.getRootPath()}/${path}`;
  }

  getFiles(dirpath, result = []) {
    fs.readdirSync(dirpath).forEach((filepath) => {
      const fullpath = `${dirpath}/${filepath}`;

      if (fs.statSync(fullpath).isDirectory()) return this.getFiles(fullpath, result);

      return result.push(fullpath);
    });

    return result;
  }

  /** **********************************************************************************************
   **                                           Helpers                                           **
   ********************************************************************************************** */

  readFile(path) {
    const buffer = fs.readFileSync(path);

    return buffer.toString('utf8');
  }

  writeFile(path, content) {
    fs.writeFileSync(path, content, { encoding: 'utf8' });
  }

  HasTextTranslate(text) {
    return /[a-zA-Z]/.test(text);
  }

  hasFullyQuery(data) {
    const limit = isWithinTokenLimit(data, 500);

    return !limit;
  }

  isAlreadyTranslated(path, uuid) {
    return this.translations.files[path]?.[uuid] !== undefined;
  }

  /** **********************************************************************************************
   **                                            Parse                                            **
   ********************************************************************************************** */

  parseQueries() {
    this.queries ||= [];

    let id = 0;

    Object.keys(this.files).forEach((path) => {
      Object.entries(this.files[path].tokens).forEach(([uuid, text]) => {
        if (this.isAlreadyTranslated(path, uuid)) {
          Logger.info(`${this.getInfos()} - ALREADY_TRANSLATED`, { path, uuid });
        } else {
          if (this.queries[id] && this.hasFullyQuery(text)) id += 1;

          this.queries[id] ||= { id, finish: false, waiting: false, data: {} };

          this.queries[id].data[path] ||= {};
          this.queries[id].data[path][uuid] = text;

          if (this.hasFullyQuery(JSON.stringify(this.queries[id].data))) id += 1;
        }
      });
    });
  }

  parseFile(file, element) {
    file.elements += 1;

    const uuid = `uuid-${file.elements}`;

    while (element.firstChild) {
      this.parseFile(file, element.firstChild);

      element.removeChild(element.firstChild);
    }

    if (!this.HasTextTranslate(element.textContent)) return;

    file.tokens ||= {};
    file.tokens[uuid] = element.textContent;
  }

  parse() {
    const paths = this.getFiles(this.getRootPath());

    paths.forEach((path) => {
      if (!path.endsWith('.html') && !path.endsWith('.xhtml')) return;

      const jsdom = new JSDOM(this.readFile(path), { xmlMode: true, parsingMode: 'auto' });

      this.files[path] = { path, tokens: {}, elements: 0 };

      this.parseFile(this.files[path], jsdom.window.document.body);
    });

    this.parseQueries();

    this.emit('parsed');
  }

  /** **********************************************************************************************
   **                                            Parse                                            **
   ********************************************************************************************** */

  getQuery() {
    return _.find(this.queries, (query) => {
      if (query.finish || query.waiting) return false;

      return true;
    });
  }

  getQueryParams(query) {
    return {
      model: 'gpt-3.5-turbo-0613',
      messages: [
        {
          role: 'user',
          content: [
            `Context:`,
            `- You are translating the content of a book from '${this.translations.source}' to '${this.translations.destination}'`,
            `Rules:`,
            `- The content is in JSON format`,
            `- Translate UNIQUELY the values of the JSON`,
            `- NOT translate anything in JSON keys (filepath and uuid)`,
            `- Preserve spaces in the string values`,
            `- The response should be formatted as the same JSON structure`,
            `Book:`,
            `- Title: ${JSON.stringify(this.epub.metadata.title)}`,
            `- Author: ${JSON.stringify(this.epub.metadata.creator)}`,
            `Content:`,
            JSON.stringify(query.data),
          ].join('\n'),
        },
      ],
    };
  }

  addTranslation(data, query) {
    try {
      const translations = JSON.parse(data.choices[0].message.content);

      Object.keys(translations).forEach((file) => {
        Object.entries(translations[file]).forEach(([uuid, value]) => {
          this.translations.files[file] ||= { count: 0 };
          this.translations.files[file][uuid] = value;

          delete query.data[file][uuid];
        });

        if (_.isEmpty(query.data[file])) delete query.data[file];
      });

      Database.addTranslations(this.translations.destination, translations);

      if (_.isEmpty(query.data)) query.finish = true;

      Logger.info(`${this.getInfos()} - SUCCESS_QUERY ${query.id}`);
    } catch (error) {
      Logger.error(`${this.getInfos()} - INVALID_JSON`);

      throw error;
    }
  }

  onQueriesInterval() {
    const query = this.getQuery();

    if (!query) return;

    query.waiting = true;

    Logger.info(`${this.getInfos()} - START_QUERY ${query.id}`);

    OpenAI.createChatCompletion(this.getQueryParams(query))
      .then((response) => {
        query.waiting = false;

        this.addTranslation(response.data, query);
      })
      .catch((err) => {
        query.waiting = false;

        Logger.error(`${this.getInfos()} - ERROR_QUERY ${query.id}`, err.response?.data || err);
      });
  }

  hasFinishQueries() {
    return this.queries.every((query) => query.finish);
  }

  stopQueriesInterval() {
    clearInterval(this.timers.queries.id);

    this.timers.queries.id = null;
  }

  startQueriesInterval() {
    this.stopQueriesInterval();

    this.timers.queries.id = setInterval(() => {
      this.onQueriesInterval();

      if (!this.hasFinishQueries()) return;

      this.translateFiles();
    }, this.timers.queries.interval);
  }

  translateFile(content, translations) {
    translations.count += 1;

    const uuid = `uuid-${translations.count}`;

    for (let i = 0; i < content.childNodes.length; i += 1) {
      this.translateFile(content.childNodes[i], translations);
    }

    if (!translations[uuid]) return;

    content.textContent = translations[uuid];
  }

  translateFiles() {
    Object.entries(this.translations.files).forEach(([path, translations]) => {
      translations.count = 0;

      const jsdom = new JSDOM(this.readFile(path), { xmlMode: true, parsingMode: 'auto' });

      this.translateFile(jsdom.window.document.body, translations);

      this.writeFile(
        path,
        prettier.format(jsdom.serialize(), { parser: 'html' }).replace(/&nbsp;/g, ' ')
      );

      Logger.info(`${this.getInfos()} - WRITE_FILE "${path}"`);
    });

    this.stopQueriesInterval();

    this.emit('translated');
  }

  translate() {
    this.startQueriesInterval();
  }

  /** **********************************************************************************************
   **                                            Write                                            **
   ********************************************************************************************** */

  write() {
    const destPath = this.getFilePath(`${this.getFilename('destination')}.epub`);
    const files = this.getFiles(this.getRootPath());
    const output = fs.createWriteStream(destPath);
    const archive = zip('zip', { store: false });

    archive.on('error', (archiveErr) => {
      throw archiveErr;
    });

    archive.pipe(output);

    output.on('close', () => {
      Logger.info(`${this.getInfos()} - WRITE_EPUB "${destPath}"`);

      this.emit('writed');
    });

    files.forEach((file) => {
      const content = fs.readFileSync(file);

      archive.append(content, {
        name: file.replace(`${this.getRootPath()}/`, ''),
      });
    });

    archive.finalize();
  }

  /** **********************************************************************************************
   **                                            Init                                             **
   ********************************************************************************************** */

  extractEpub() {
    const rootPath = this.getRootPath();

    if (fs.existsSync(rootPath)) {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }

    this.epub.zip.admZip.extractAllTo(rootPath, true);
  }

  init() {
    this.epub = new EPUB(this.path);

    this.epub.on('end', async () => {
      this.extractEpub();

      this.translations.files = Database.getTranslations(this.translations.destination);

      this.emit('initiated');
    });

    this.epub.parse();
  }
}
