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

const MAX_TOKENS = 750;

export default class EpubInterface extends EventEmitter {
  constructor(params) {
    super();

    this.files = {};

    this.path = params.path;

    this.metadata = params.metadata || {};

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
    if (!this.epub.manifest[this.epub.metadata.cover]) {
      return _.find(this.epub.manifest, (el) => el.href.includes(this.epub.metadata.cover))?.href;
    }

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
            `Contexte :`,
            `- Traduire le contenu d'un livre vers le ${this.translations.destination}`,
            `Règles :`,
            `- Peut importe la langue source le text final doit etre en ${this.translations.destination}`,
            `- Le contenu est au format JSON`,
            `- Traduire UNIQUEMENT les valeurs du JSON`,
            `- NE traduisez rien dans les clés JSON (chemin de fichier et UUID)`,
            `- Préservez les espaces dans les valeurs de chaîne de caractères`,
            `- La réponse doit être formatée de la même structure JSON`,
            `Livre :`,
            `- Titre : ${JSON.stringify(this.epub.metadata.title)}`,
            `- Auteur : ${JSON.stringify(this.epub.metadata.creator)}`,
            `Contenu :`,
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

  removeBadHtmlTag(html) {
    html = html.replace(/<b\s*[^>]*>([A-Za-z])<\/b>/g, (match, letter) => letter);
    html = html.replace(/<i\s*[^>]*>([A-Za-z])<\/i>/g, (match, letter) => letter);

    return html;
  }

  readHTML(path) {
    let html = this.readFile(path);

    _.times(3, () => (html = this.removeBadHtmlTag()));

    return html;
  }

  readFile(path) {
    const buffer = fs.readFileSync(path);

    return buffer.toString('utf8');
  }

  hasFinishQueries() {
    return this.queries.every((query) => query.finish);
  }

  hasFullyQuery(data) {
    const limit = isWithinTokenLimit(data, MAX_TOKENS);

    return !limit;
  }

  hasTextTranslate(text) {
    const regex = /^[^\p{L}]*$/u;

    return !regex.test(text);
  }

  isAlreadyTranslated(translation) {
    return translation !== undefined;
  }

  isValidTranslation(translation = '', origin = '') {
    if (translation.length < origin.length / 10) {
      Logger.info(`${this.getInfos()} - BAD_TRANSLATION`);

      return false;
    }

    if (origin.length < translation.length / 10) {
      Logger.info(`${this.getInfos()} - BAD_TRANSLATION`);

      return false;
    }

    return !translation.includes('\\"uuid-');
  }

  /** **********************************************************************************************
   **                                            Parse                                            **
   ********************************************************************************************** */

  parseQuote(text) {
    return text
      .replace(/(“ | ”|《 | 》|« | »|<< | >>)/g, '"')
      .replace(/(“|”|《|》|«|»|<<|>>)/g, '"');
  }

  parseQueries() {
    this.queries ||= [];

    let id = 0;

    Object.keys(this.files).forEach((path) => {
      Object.entries(this.files[path].tokens).forEach(([uuid, text]) => {
        if (
          this.isAlreadyTranslated(this.translations.files[path]?.[uuid]) &&
          this.isValidTranslation(this.translations.files[path]?.[uuid], text)
        ) {
          this.translations.files[path][uuid] = this.parseQuote(
            this.translations.files[path][uuid]
          );

          Database.addTranslation(
            this.translations.destination,
            path,
            uuid,
            this.translations.files[path][uuid]
          );

          Logger.info(`${this.getInfos()} - ALREADY_TRANSLATED`, { path, uuid });
        } else {
          if (this.queries[id] && this.hasFullyQuery(text)) id += 1;

          this.queries[id] ||= { id, finish: false, waiting: false, data: {} };

          this.queries[id].data[path] ||= {};
          this.queries[id].data[path][uuid] = this.parseQuote(text);

          if (this.hasFullyQuery(JSON.stringify(this.queries[id].data))) id += 1;
        }
      });
    });
  }

  skipTag(html, index, tag = '</code>') {
    while (index < html.length) {
      if (html.slice(index, index + tag.length) === tag) break;

      index += 1;
    }

    return index + tag.length - 1;
  }

  parseFile(file, html) {
    let skip = false;

    for (let index = 0; index < html.length; index += 1) {
      if (html.slice(index, index + 6) === '<style') skip = true;

      if (html.slice(index, index + 4) === '<pre') index = this.skipTag(html, index, '</pre>');

      if (html.slice(index, index + 5) === '<code') index = this.skipTag(html, index, '</code>');

      if (html[index] === '>' && !skip) {
        file.elements += 1;

        while (html[index + 1] && html[index + 1] !== '<') {
          index += 1;

          file.tokens[`uuid-${file.elements}`] ||= '';
          file.tokens[`uuid-${file.elements}`] += html[index];
        }

        if (!this.hasTextTranslate(file.tokens[`uuid-${file.elements}`])) {
          delete file.tokens[`uuid-${file.elements}`];
        }
      } else if (html[index] === '>' && skip) {
        skip = false;
      }
    }
  }

  parse() {
    const paths = this.getFiles(this.getRootPath());

    paths.forEach((path) => {
      if (path.endsWith('.opf')) {
        this.writeOPF(path);
      }

      if (path.endsWith(this.getCoverPath())) {
        this.writeCover(path);
      }

      if (path.endsWith('.html') || path.endsWith('.xhtml')) {
        this.files[path] = { path, tokens: {}, elements: 0 };

        this.parseFile(this.files[path], this.readHTML(path));
      }
    });

    this.parseQueries();

    this.emit('parsed');
  }

  /** **********************************************************************************************
   **                                          Translate                                          **
   ********************************************************************************************** */

  fixStringJSON(jsonString) {
    return jsonString.replace(/ "/g, ' \\"').replace(/" /g, '\\" ');
  }

  addTranslation(data, query, retry = false) {
    try {
      const translations = retry
        ? JSON.parse(this.fixStringJSON(data.choices[0].message.content))
        : JSON.parse(data.choices[0].message.content);

      Object.keys(translations).forEach((file) => {
        Object.entries(translations[file]).forEach(([uuid, value]) => {
          if (!this.isValidTranslation(value, query.data[file][uuid])) return;

          this.translations.files[file] ||= {};
          this.translations.files[file][uuid] = this.parseQuote(value);

          delete query.data[file][uuid];
        });

        if (_.isEmpty(query.data[file])) delete query.data[file];
      });

      Database.addTranslations(this.translations.destination, translations);

      if (_.isEmpty(query.data)) query.finish = true;

      Logger.info(`${this.getInfos()} - SUCCESS_QUERY ${query.id}`);
    } catch (error) {
      if (!retry) {
        this.addTranslation(data, query, true);
      } else {
        Logger.error(`${this.getInfos()} - INVALID_JSON`, data.choices[0].message.content);

        throw error;
      }
    }
  }

  translateReplace(translations, uuid) {
    return this.parseQuote(translations[uuid]?.replace(/&(?!amp;)/g, '&amp;'));
  }

  translateFile(path, translations) {
    const origins = this.files[path].tokens;

    let file = this.readHTML(path);

    Object.keys(translations).forEach((uuid) => {
      if (typeof origins[uuid] !== 'string' || typeof translations[uuid] !== 'string') return;

      const translation = this.translateReplace(translations, uuid);

      if (origins[uuid].startsWith(' ') && !translation.startsWith(' ')) {
        file = file.replace(`>${origins[uuid]}<`, `> ${translation}<`);
      } else {
        file = file.replace(`>${origins[uuid]}<`, `>${translation}<`);
      }
    });

    return file;
  }

  translateFiles() {
    const rootPath = this.getRootPath();

    Object.entries(this.translations.files).forEach(([path, translations]) => {
      if (!path.startsWith(rootPath) || !this.files[path]) return;

      const file = this.translateFile(path, translations);

      this.writeFile(path, file);

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
    context.lineTo(0, 90);
    context.lineTo(275, 90);
    context.lineTo(350, 0);
    context.closePath();

    context.lineWidth = 8;
    context.strokeStyle = '#a20000';
    context.stroke();

    context.fillStyle = '#fff9b8';
    context.fill();

    context.fillStyle = '#16180f';
    context.textAlign = 'center';
    context.font = '34px "Times New Roman"';
    context.fillText('The Babel Library', 160, 45);
    context.font = '20px "Times New Roman"';
    context.fillText(`Translated from "${this.translations.source}"`, 142, 70);

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
    let { cover } = this.epub.metadata;

    if (!_.find(this.epub.manifest, { id: cover })) {
      cover = _.find(this.epub.manifest, (el) => el.href.includes(this.epub.metadata.cover))?.id;
    }

    return cover ? `<meta name="cover" content="${cover}"/>` : ``;
  }

  getMetadata() {
    return `
    ${this.getMetadataTitle()}
    ${this.getMetadataCreator()}
    ${this.getMetadataDate()}
    ${this.getMetadataPublisher()}
    ${this.getMetadataLanguage()}
    ${this.getMetadataSerie()}
    ${this.getMetadataSeriesIndex()}
    ${this.getMetadataCover()}`.replace(/^\s*\n/gm, '');
  }

  writeOPF(path) {
    const content = this.readFile(path);

    const regex = /(<metadata\b[^>]*>)([\s\S]*?)(<\/metadata>)/;

    this.writeFile(path, content.replace(regex, `$1${this.getMetadata()}$3`));
  }

  /** **********************************************************************************************
   **                                            Write                                            **
   ********************************************************************************************** */

  write() {
    const rootPath = this.getRootPath();
    const destPath = `./library/destinations/${this.getFilename('destination')}.epub`;

    const files = this.getFiles(rootPath);
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
        name: file.replace(`${rootPath}/`, ''),
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
          this.epub.metadata.cover ||= 'cover';

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
