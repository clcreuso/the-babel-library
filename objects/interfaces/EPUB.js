/* eslint-disable max-len */

import _ from 'lodash';
import fs from 'fs';
import EPUB from 'epub';
import zip from 'archiver';
import dotenv from 'dotenv';
import prompt from 'prompt';
import crypto from 'crypto';
import mime from 'mime-types';
import iso6391 from 'iso-639-1';
import prettier from 'prettier';

import { JSDOM } from 'jsdom';
import { EventEmitter } from 'events';
import { isWithinTokenLimit } from 'gpt-tokenizer';
import { createCanvas, loadImage } from 'canvas';
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

    this.metadata = {};

    this.translations = {
      source: params.source || 'English',
      destination: params.destination || 'English',
      files: {},
    };

    this.timers = {
      queries: { id: null, interval: 1000 },
    };
  }

  /** **********************************************************************************************
   **                                           Getters                                           **
   ********************************************************************************************** */

  getInfos() {
    return `EPUB (${this.getFilename()})`;
  }

  getRootPath() {
    return `./tmp/${this.getFileUUID()}`;
  }

  getFilePath(path) {
    return `${this.getRootPath()}/${path}`;
  }

  getCoverPath() {
    return this.epub.manifest[this.epub.metadata.cover]?.href;
  }

  getIsoCode(language) {
    const code = iso6391.getCode(language);

    return code ? code.toLowerCase() : null;
  }

  getStatus() {
    return `EPUB (${this.getFilename()}) - STATUS ${
      _.filter(this.queries, (query) => query.finish).length
    }/${this.queries.length}`;
  }

  getFileUUID() {
    const fileContent = fs.readFileSync(this.path);

    return crypto.createHash('md5').update(fileContent).digest('hex');
  }

  getFilename(type = 'source') {
    const iso = this.getIsoCode(this.translations[type]);
    const title = this.metadata.title || this.epub.metadata.title;
    const creator = this.metadata.creator || this.epub.metadata.creator;

    return `${title} - ${creator} (${iso})`;
  }

  getQuery() {
    return _.find(this.queries, (query) => {
      if (query.finish || query.waiting) return false;

      return true;
    });
  }

  getFiles(dirpath, result = []) {
    fs.readdirSync(dirpath).forEach((filepath) => {
      const fullpath = `${dirpath}/${filepath}`;

      if (fs.statSync(fullpath).isDirectory()) return this.getFiles(fullpath, result);

      return result.push(fullpath);
    });

    return result;
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

  /** **********************************************************************************************
   **                                           Helpers                                           **
   ********************************************************************************************** */

  writeFile(path, content) {
    fs.writeFileSync(path, content, { encoding: 'utf8' });
  }

  readHTML(path) {
    return this.readFile(path).replace(/<a\b[^>]*\/>/g, '');
  }

  readFile(path) {
    const buffer = fs.readFileSync(path);

    return buffer.toString('utf8');
  }

  HasTextTranslate(text) {
    return /[a-zA-Z]/.test(text);
  }

  hasFinishQueries() {
    return this.queries.every((query) => query.finish);
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
          this.queries[id].data[path][uuid] = text.replace(/(“|”)/g, '"');

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
      if (path.endsWith('content.opf')) {
        this.writeOPF(path);
      }

      if (path.endsWith(this.getCoverPath())) {
        this.writeCover(path);
      }

      if (path.endsWith('.html') || path.endsWith('.xhtml')) {
        const jsdom = new JSDOM(this.readHTML(path));

        this.files[path] = { path, tokens: {}, elements: 0 };

        this.parseFile(this.files[path], jsdom.window.document.body);
      }
    });

    this.parseQueries();

    this.emit('parsed');
  }

  /** **********************************************************************************************
   **                                          Translate                                          **
   ********************************************************************************************** */

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
    const rootPath = this.getRootPath();

    Object.entries(this.translations.files).forEach(([path, translations]) => {
      if (!path.startsWith(rootPath)) return;

      translations.count = 0;

      const jsdom = new JSDOM(this.readHTML(path));

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

  translate() {
    this.startQueriesInterval();
  }

  /** **********************************************************************************************
   **                                        Write: Cover                                         **
   ********************************************************************************************** */

  async writeCover(path) {
    const image = await loadImage(path);

    const canvas = createCanvas(800, 1280);
    const context = canvas.getContext('2d');

    context.drawImage(image, 0, 0, 800, 1280);

    context.beginPath();
    context.moveTo(0, 0);
    context.lineTo(0, 80);
    context.lineTo(250, 80);
    context.lineTo(300, 0);
    context.closePath();

    context.lineWidth = 8;
    context.strokeStyle = '#a20000';
    context.stroke();

    context.fillStyle = '#fff9b8';
    context.fill();

    context.fillStyle = '#16180f';
    context.textAlign = 'center';
    context.font = '30px "Times New Roman"';
    context.fillText('The Babel Library', 132, 50);

    const buffer = canvas.toBuffer(mime.lookup(path));

    fs.writeFileSync(path, buffer);
  }

  /** **********************************************************************************************
   **                                         Write: OPF                                          **
   ********************************************************************************************** */

  getMetadataTitle() {
    const title = this.metadata.title || this.epub.metadata.title;

    return title ? `<dc:title>${title}</dc:title>` : ``;
  }

  getMetadataCreator() {
    const creator = this.metadata.creator || this.epub.metadata.creator;

    return creator ? `<dc:creator>${creator}</dc:creator>` : ``;
  }

  getMetadataDate() {
    const { date } = this.epub.metadata;

    return date ? `<dc:date>${date}</dc:date>` : ``;
  }

  getMetadataPublisher() {
    const { publisher } = this.epub.metadata || 'The Babel Library';

    return publisher ? `<dc:publisher>${publisher}</dc:publisher>` : ``;
  }

  getMetadataLanguage() {
    const iso = this.getIsoCode(this.translations.destination);

    return iso ? `<dc:language>${iso}</dc:language>` : ``;
  }

  getMetadataSerie() {
    const { series_name } = this.metadata;

    return series_name ? `<meta name="calibre:series" content="${series_name}"/>` : ``;
  }

  getMetadataSeriesIndex() {
    const { series_volume } = this.metadata;

    return series_volume ? `<meta name="calibre:series_index" content="${series_volume}"/>` : ``;
  }

  getMetadataCover() {
    const { cover } = this.metadata;

    return cover ? `<meta name="cover" content="${cover}"/>` : ``;
  }

  getMetadata() {
    return `<metadata xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:calibre="http://calibre.kovidgoyal.net/2009/metadata" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    ${this.getMetadataTitle()}
    ${this.getMetadataCreator()}
    ${this.getMetadataDate()}
    ${this.getMetadataPublisher()}
    ${this.getMetadataLanguage()}
    ${this.getMetadataSerie()}
    ${this.getMetadataSeriesIndex()}
    ${this.getMetadataCover()}
  </metadata>`.replace(/^\s*\n/gm, '');
  }

  writeOPF(path) {
    const content = this.readFile(path);

    const regex = /<metadata\b[^>]*>([\s\S]*?)<\/metadata>/;

    this.writeFile(path, content.replace(regex, this.getMetadata()));
  }

  /** **********************************************************************************************
   **                                            Write                                            **
   ********************************************************************************************** */

  write() {
    const destPath = `./library/destinations/${this.getFilename('destination')}.epub`;
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

  initMetadata() {
    return new Promise((resolve) => {
      prompt.get(
        [
          { name: 'title', description: 'Book title', default: this.epub.metadata.title },
          { name: 'creator', description: 'Book creator', default: this.epub.metadata.creator },
          { name: 'series_name', description: 'Book series name' },
          { name: 'series_volume', description: 'Book series volume' },
        ],
        (_err, result) => {
          this.metadata.title = result.title;
          this.metadata.creator = result.creator;
          this.metadata.series_name = result.series_name;
          this.metadata.series_volume = result.series_volume;

          Logger.info(`${this.getInfos()} - INIT_METADATA`, this.metadata);

          resolve();
        }
      );
    });
  }

  initEpub() {
    const rootPath = this.getRootPath();

    if (fs.existsSync(rootPath)) {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }

    this.epub.zip.admZip.extractAllTo(rootPath, true);
  }

  init() {
    this.epub = new EPUB(this.path);

    this.epub.on('end', async () => {
      this.initEpub();

      await this.initMetadata();

      this.translations.files = Database.getTranslations(this.translations.destination);

      this.emit('initiated');
    });

    this.epub.parse();
  }
}
