/* eslint-disable max-len */
/* eslint-disable prefer-destructuring */
/* eslint-disable import/no-extraneous-dependencies */

/* eslint-disable no-restricted-syntax */

import _ from 'lodash';
import fs from 'fs';
import zip from 'archiver';

// import sharp from 'sharp';
// import axios from 'axios';
// import prompt from 'prompt';
// import ytdl from 'ytdl-core';
// import mime from 'mime-types';
// import beautify from 'simply-beautiful';

import { jsonrepair } from 'jsonrepair';
import { EventEmitter } from 'events';
import { minify } from 'html-minifier-terser';
// import { createCanvas, loadImage } from 'canvas';
// import { getSubtitles } from 'youtube-captions-scraper';

import Logger from '../../config/logger.js';
// import Toolbox from '../../config/Toolbox.js';

import sendRequest from './Request.js';

export default class EpubInterface extends EventEmitter {
  constructor(params) {
    super();

    this.params = {
      user: params.user || 'Default',
      theme: params.theme || 'La Cuisine',
      language: params.language || 'French',
      model: params.model || 'gpt-4o-2024-11-20',
    };

    this.constants = {
      tmp: './tmp/epub/',
      default: './assets/epub/',
      html_folder: './tmp/epub/OPS/',
      chapter_template: `./tmp/epub/OPS/chapter_template.xhtml`,
      cover_name: `/epub/cover.png`,
      titlepage: './tmp/epub/titlepage.xhtml',
      database: './db/dictionary/Database.json',
      gitkeep: './tmp/epub/.gitkeep',
      opf: './tmp/epub/content.opf',
      ncx: './tmp/epub/toc.ncx',
    };

    this.pathes = [];
    this.queries = [];
    this.categories = [];

    this.timers = {
      queries: { id: null, interval: 1000 },
    };
  }

  /** **********************************************************************************************
   **                                           Getters                                           **
   ********************************************************************************************** */

  getInfos() {
    return `EPUB (${this.getEpubName()})`;
  }

  getQuery() {
    return _.find(Object.values(this.queries), (query) => !query.finish && !query.waiting);
  }

  getEpubName() {
    return `${this.params.theme}.epub`;
  }

  getEpubPath() {
    return `./library/Dictionary/${this.getEpubName()}`;
  }

  getStatus() {
    const queries = Object.values(this.queries);

    const finisheds = _.filter(queries, (query) => query.finish).length;

    return `${this.getInfos()} - STATUS ${finisheds}/${queries.length}`;
  }

  /** **********************************************************************************************
   **                                           Helpers                                           **
   ********************************************************************************************** */

  hasFinish() {
    return Object.values(this.queries).every((query) => query.finish);
  }

  readFile(path) {
    return fs.readFileSync(path).toString('utf8');
  }

  writeFile(path, content) {
    fs.writeFileSync(path, content, { encoding: 'utf8' });
  }

  /** **********************************************************************************************
   **                                         Write: OPF                                          **
   ********************************************************************************************** */

  getMetadataTitle() {
    return `\t<dc:title id="t1">${this.params.theme}</dc:title>`;
  }

  getMetadataLanguage() {
    return `\t<dc:language>fr</dc:language>`;
  }

  getMetadata() {
    return [this.getMetadataTitle(), this.getMetadataLanguage()].join('\n');
  }

  writeOPF() {
    let content = this.readFile(this.constants.opf);

    content = content.replace(
      /(<metadata\b[^>]*>)([\s\S]*?)(<\/metadata>)/,
      `$1\n${this.getMetadata()}\n$3`
    );

    this.writeFile(this.constants.opf, content);
  }

  /** **********************************************************************************************
   **                                        Write: Folder                                        **
   ********************************************************************************************** */

  initFolderEPUB() {
    fs.rmSync(this.constants.tmp, { recursive: true, force: true });

    fs.cpSync(this.constants.default, this.constants.tmp, { recursive: true });
  }

  /** **********************************************************************************************
   **                                       Write: Chapters                                       **
   ********************************************************************************************** */

  writeFileInOPF(id) {
    let content = this.readFile(this.constants.opf);

    const spine = `<itemref idref="${id}"/>`;
    const manifest = `<item id="${id}" href="OPS/${id}.xhtml" media-type="application/xhtml+xml"/>`;

    content = content.replace(/<\/spine>/, `\t${spine}\n\t</spine>`);
    content = content.replace(/<\/manifest>/, `\t${manifest}\n\t</manifest>`);

    this.writeFile(this.constants.opf, content);
  }

  writeFileInNCX(order, title) {
    let content = this.readFile(this.constants.ncx);

    content = content.replace(
      /<\/navMap>/,
      `${[
        `\t<navPoint playOrder="${order + 1}" class="chapter">`,
        `\t\t<navLabel><text>${title}</text></navLabel>`,
        `\t\t<content src="OPS/chapter_${order}.xhtml"/>`,
        `\t</navPoint>`,
      ].join('\n')}\n</navMap>`
    );

    this.writeFile(this.constants.ncx, content);
  }

  writeChapters() {
    this.queries.forEach((query, index) => {
      if (!query.response) return;

      let file = this.readFile(this.constants.chapter_template);

      file = file.replace('TITLE', `${this.params.theme} - ${query.category}`);
      file = file.replace(
        /<body([^>]*)>([\s\S]*?)<\/body>/i,
        `<body$1>\n<h2>${this.params.theme} - ${query.category}</h2\n>${query.response}\n</body>`
      );

      this.writeFile(`${this.constants.html_folder}chapter_${index + 1}.xhtml`, file);

      this.writeFileInOPF(`chapter_${index + 1}`);

      this.writeFileInNCX(index + 1, query.category);
    });

    fs.rmSync(this.constants.chapter_template);
  }

  /** **********************************************************************************************
   **                                         Write: Cover                                        **
   ********************************************************************************************** */

  async fetchCoverImage() {
    try {
      const response = await sendRequest({ type: 'cover', theme: this.params.theme });

      const imageBuffer = Buffer.from(response.data.data[0].b64_json, 'base64');

      fs.writeFileSync('tmp/epub/cover.png', imageBuffer);

      Logger.info(`Image de couverture générée pour le thème: ${this.params.theme}`);
    } catch (error) {
      Logger.error(`Erreur lors de la récupération de la couverture via OpenAI`, error);
    }
  }

  updateCoverOPF() {
    let file = this.readFile(this.constants.opf);

    file = file.replace('COVER_PATH', 'cover.png');

    file = file.replace('COVER_TYPE', 'image/png');

    this.writeFile(this.constants.opf, file);
  }

  updateCoverTitlepage() {
    let file = this.readFile(this.constants.titlepage);

    file = file.replace('TITLE', this.params.theme);

    file = file.replace('COVER_PATH', 'cover.png');

    this.writeFile(this.constants.titlepage, file);
  }

  async writeCover() {
    await this.fetchCoverImage();

    this.updateCoverOPF();

    this.updateCoverTitlepage();
  }

  /** **********************************************************************************************
   **                                            Write                                            **
   ********************************************************************************************** */

  initPathes(dirpath = this.constants.tmp) {
    fs.readdirSync(dirpath).forEach((filepath) => {
      const fullpath = `${dirpath}/${filepath}`.replace('//', '/');

      return fs.statSync(fullpath).isDirectory()
        ? this.initPathes(fullpath)
        : this.pathes.push(fullpath);
    });
  }

  writeEPUB() {
    const output = fs.createWriteStream(this.getEpubPath());
    const archive = zip('zip', { store: false });

    archive.on('error', (archiveErr) => {
      throw archiveErr;
    });

    archive.pipe(output);

    output.on('close', () => {
      Logger.info(`${this.getInfos()} - WRITE_EPUB "${this.getEpubPath()}"`);

      this.emit('writed');
    });

    this.pathes.forEach((path) => {
      archive.append(fs.readFileSync(path), {
        name: path.replace(this.constants.tmp, ''),
      });
    });

    archive.finalize();
  }

  async write() {
    this.initFolderEPUB();

    this.writeOPF();

    this.writeChapters();

    await this.writeCover();

    this.initPathes();

    this.writeEPUB();
  }

  /** **********************************************************************************************
   **                                           Parsing                                           **
   ********************************************************************************************** */

  getJSONRepair(str) {
    try {
      let result = str.slice(str.indexOf('{'), str.lastIndexOf('}') + 1);

      result = result.replaceAll(': undefined', ': "undefined"');

      return jsonrepair(result);
    } catch (error) {
      Logger.error(`${this.getInfos()} - GET_JSON_REPAIR`, str, error);

      return str;
    }
  }

  parseResponseJSON(data) {
    if (data.length < 50) return undefined;

    try {
      return JSON.parse(this.getJSONRepair(data));
    } catch (error) {
      Logger.error(`${this.getInfos()} - PARSE_RESPONSE_JSON`, data, error);

      return undefined;
    }
  }

  /** **********************************************************************************************
   **                                           Process                                           **
   ********************************************************************************************** */

  parseHTML(html) {
    return minify(html, {
      collapseWhitespace: true,
      keepClosingSlash: true,
      minifyCSS: true,
      minifyJS: true,
      removeComments: true,
      removeEmptyAttributes: true,
      removeRedundantAttributes: true,
      removeScriptTypeAttributes: true,
      removeStyleLinkTypeAttributes: true,
      useShortDoctype: true,
    }).then((res) => {
      res = res.replace(/&(?!amp;)/g, '&amp;');

      res = res.replaceAll('< /', '</');

      res = res.replace(/\s+/g, ' ');

      res = res.replace(/<br\s*\/?>/gi, '<br />');

      res = res.replace(/<h>/gi, '<h3>');
      res = res.replace(/<\/h>/gi, '</h3>');

      res = res.replace(/<h[1-6]/gi, '<h3');
      res = res.replace(/h[1-6]>/gi, 'h3>');

      res = res.replace(/<h3/i, '<h2');
      res = res.replace(/h3>/i, 'h2>');

      return res;
    });
  }

  async parseDictionaryRequest(data, query) {
    try {
      query.count += 1;

      const response = this.parseResponseJSON(data);

      if (!response?.content) {
        query.response = undefined;
        query.finish = query.count > 2;
      } else {
        query.response = await this.parseHTML(response.content).catch((err) => {
          Logger.error(`${this.getInfos()} - PARSE_HTML_REQUEST_SUMMARIZE`, err);

          return undefined;
        });

        query.finish = query.response !== undefined || query.count > 2;
      }
    } catch (error) {
      Logger.error(`${this.getInfos()} - PARSE_SUMMARIZE_REQUEST`, error, data);
    }
  }

  sendDictionaryRequest(query = this.getQuery()) {
    if (!query) return;

    query.waiting = true;

    sendRequest({
      type: 'chapter',
      model: this.params.model,
      theme: this.params.theme,
      language: this.params.language,
      category: query.category,
    })
      .then((response) => {
        this.parseDictionaryRequest(response, query);

        Logger.info(this.getStatus());
      })
      .catch((err) => {
        Logger.error(`${this.getInfos()} - SEND_DICTIONARY_REQUEST`, err.response?.data || err);
      })
      .finally(() => {
        query.waiting = false;
      });

    Logger.info(
      `${this.getInfos()} - SEND_DICTIONARY_REQUEST (${this.params.theme} - ${query.category})`
    );
  }

  /** **********************************************************************************************
   **                                           Process                                           **
   ********************************************************************************************** */

  onProcessInterval() {
    if (this.hasFinish()) {
      this.emit('processed');

      this.stopProcessInterval();
    } else {
      this.sendDictionaryRequest();
    }
  }

  stopProcessInterval() {
    clearInterval(this.timers.queries.id);

    this.timers.queries.id = null;
  }

  process() {
    this.stopProcessInterval();

    this.onProcessInterval();

    this.timers.queries.id = setInterval(() => {
      this.onProcessInterval();
    }, this.timers.queries.interval);

    Logger.info(`${this.getInfos()} - START_PROCESS_INTERVAL`);
  }

  /** **********************************************************************************************
   **                                            Parse                                            **
   ********************************************************************************************** */

  parseQueries() {
    this.categories.forEach((category) => {
      this.queries.push({ category, response: null, waiting: false, finish: false });
    });
  }

  parse() {
    this.parseQueries();

    this.emit('parsed');
  }

  /** **********************************************************************************************
   **                                      Categories: Init                                       **
   ********************************************************************************************** */

  sendCategoriesRequest() {
    return sendRequest({
      type: 'categories',
      model: this.params.model,
      theme: this.params.theme,
      language: this.params.language,
    })
      .then((response) => {
        const resJSON = this.parseResponseJSON(response);

        return resJSON.categories;
      })
      .catch((err) => {
        Logger.error(`${this.getInfos()} - SEND_SUMMARIZE_REQUEST`, err.response?.data || err);
      });
  }

  async initCategories() {
    const categories = await this.sendCategoriesRequest();

    categories.forEach((category) => {
      category = _.startCase(category);

      if (category.includes(' ')) return;

      if (category.includes(this.params.theme)) return;

      if (this.params.theme.includes(category)) return;

      if (this.categories.includes(category)) return;

      this.categories.push(category);
    });

    this.categories = _.sortBy(this.categories);

    Logger.info(`${this.getInfos()} - INIT_CATEGORIES`, this.categories);
  }

  /** **********************************************************************************************
   **                                       Database: Init                                        **
   ********************************************************************************************** */

  readDatabase() {
    try {
      return JSON.parse(this.readFile(this.constants.database));
    } catch (error) {
      return [];
    }
  }

  writeDatabase() {
    let database = this.readDatabase();

    database = _.filter(database, (el) => el.theme !== this.params.theme);

    database.push({ theme: this.params.theme, categories: this.categories, ready: false });

    this.writeFile(this.constants.database, JSON.stringify(database, null, 2));

    Logger.info(`${this.getInfos()} - WRITE_DATABASE`, this.constants.database);
  }

  hasInitDatabase() {
    const database = this.readDatabase();

    const data = _.find(database, { theme: this.params.theme });

    if (!data) return false;

    this.categories = _.sortBy(data.categories);

    return data.ready;
  }

  /** **********************************************************************************************
   **                                            Init                                             **
   ********************************************************************************************** */

  async init() {
    if (this.hasInitDatabase()) {
      this.emit('initiated');
    } else {
      await this.initCategories();

      await this.initCategories();

      await this.initCategories();

      this.writeDatabase();
    }
  }
}
