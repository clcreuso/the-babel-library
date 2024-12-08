/* eslint-disable prefer-destructuring */
/* eslint-disable import/no-extraneous-dependencies */

/* eslint-disable no-restricted-syntax */

import _ from 'lodash';
import fs from 'fs';
import EPUB from 'epub';
import zip from 'archiver';
import dotenv from 'dotenv';
import prompt from 'prompt';
import mime from 'mime-types';
import iso6391 from 'iso-639-1';
import inquirer from 'inquirer';
import beautify from 'simply-beautiful';

import { jsonrepair } from 'jsonrepair';
import { EventEmitter } from 'events';
import { minify } from 'html-minifier-terser';
import { createCanvas, loadImage } from 'canvas';
import { Configuration, OpenAIApi } from 'openai';

import getContext from '../queries/Main.js';

import Logger from '../../config/logger.js';
import Toolbox from '../../config/Toolbox.js';

dotenv.config();

const OpenAI = new OpenAIApi(
  new Configuration({ organization: process.env.OPEN_AI_ORG, apiKey: process.env.OPEN_AI_KEY })
);

function cleanHtmlForEpub(html) {
  const options = {
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
  };

  return minify(html, options);
}

export default class EpubInterface extends EventEmitter {
  constructor(params) {
    super();

    this.params = {
      user: params.user || 'Toto',
      source: params.source || 'English',
      destination: params.destination || 'French',
      model: params.model || 'gpt-4o-2024-11-20',
      // model: params.model || 'gpt-4o-mini-2024-07-18',
    };

    this.metadata = params.metadata || {};

    this.timers = {
      queries: { id: null, interval: 500 },
    };

    this.setFile(params.path);
  }

  /** **********************************************************************************************
   **                                           Getters                                           **
   ********************************************************************************************** */

  getInfos() {
    return `EPUB (${this.getEpubName()})`;
  }

  getFile() {
    return _.find(Object.values(this.files), (file) => !file.finish && !file.waiting);
  }

  getIsoCode(language) {
    const code = iso6391.getCode(language);

    return code ? code.toLowerCase() : null;
  }

  getStatus() {
    const files = Object.values(this.files);

    return `${this.getInfos()} - STATUS ${_.filter(files, (file) => file.finish).length}/${
      files.length
    }`;
  }

  getCover() {
    return _.find(this.epub.manifest, (el) => {
      if (!el['media-type'].includes('image')) return false;

      return _.some(Object.values(el), (value) => {
        if (typeof value !== 'string') return false;

        return value.toLowerCase().includes('cover');
      });
    });
  }

  getFileInfo(path) {
    const result = _.find(Object.values(this.epub.manifest), (el) => path.includes(el.href));

    return {
      ...result,
      filename: result.href.match(/[^/]+$/)[0],
    };
  }

  getEpubName() {
    const { title, subtitle, creator } = this.metadata;

    if (title && subtitle && creator) return `${title} - ${subtitle} | ${creator} (résumé)`;

    if (title && creator) return `${title} | ${creator} (résumé)`;

    return `${title} (résumé)`;
  }

  getEpubPath() {
    return `./library/${this.getEpubName()}.epub`;
  }

  /** **********************************************************************************************
   **                                           Setters                                           **
   ********************************************************************************************** */

  setCover(cover) {
    this.metadata.cover_id = cover.id;
    this.metadata.cover_name = cover.href.match(/[^/]+$/)[0];
    this.metadata.cover_path = cover.href;
  }

  setFile(path) {
    this.file = {};

    this.file.path = path;
    this.file.hash = Toolbox.getFileHash(path);
    this.file.folder = `./tmp/${this.file.hash}`;
  }

  /** **********************************************************************************************
   **                                           Helpers                                           **
   ********************************************************************************************** */

  isHTML(path) {
    return (
      path.includes('.htm') ||
      path.includes('.html') ||
      path.includes('.xhtml') ||
      path.includes('.xml')
    );
  }

  hasFinish() {
    return Object.values(this.files).every((file) => file.finish);
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
    const title = this.metadata.title || this.epub.metadata.title;

    return title
      ? `<dc:title id="t1">${title}</dc:title>
    <meta property="title-type" refines="#t1">main</meta>
    <meta property="display-seq" refines="#t1">1</meta>`
      : ``;
  }

  getMetadataSubtitle() {
    const { subtitle } = this.metadata;

    return subtitle
      ? `<dc:title id="t2">${subtitle}</dc:title>
    <meta property="title-type" refines="#t2">subtitle</meta>
    <meta property="display-seq" refines="#t2">1</meta>`
      : ``;
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
    const iso = this.getIsoCode(this.params.destination);

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
    return this.metadata.cover_id ? `<meta name="cover" content="${this.metadata.cover_id}"/>` : ``;
  }

  getMetadata() {
    return [
      this.getMetadataTitle(),
      this.getMetadataSubtitle(),
      this.getMetadataCreator(),
      this.getMetadataDate(),
      this.getMetadataPublisher(),
      this.getMetadataLanguage(),
      this.getMetadataSerie(),
      this.getMetadataSeriesIndex(),
      this.getMetadataCover(),
    ].join('');
  }

  writeOPF(path) {
    let content = this.readFile(path);

    content = content.replace(
      /(<metadata\b[^>]*>)([\s\S]*?)(<\/metadata>)/,
      `$1${this.getMetadata()}$3`
    );

    content = content.replace(/&(?!amp;)/g, '&amp;');

    this.writeFile(path, content);
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
    context.fillText(`-- Summarized --`, 142, 70);

    const buffer = canvas.toBuffer(mime.lookup(path));

    fs.writeFileSync(path, buffer);
  }

  /** **********************************************************************************************
   **                                            Write                                            **
   ********************************************************************************************** */

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

    this.file.paths.forEach((path) => {
      archive.append(fs.readFileSync(path), {
        name: path.replace(`${this.file.folder}/`, ''),
      });
    });

    archive.finalize();
  }

  getResumeHTML(html, file) {
    return html.replace(
      /<body([^>]*)>([\s\S]*?)<\/body>/i,
      beautify.html(`<body$1>${file.response}</body>`)
    );
  }

  // removeElement(html, text) {
  //   html = html.replace(new RegExp(`<[^>]+>[^<]*${text}"[^<]*<\\/[^>]+>`, 'gi'), '');

  //   html = html.replace(new RegExp(`<[^>]+?${text}"[^>]*?\\/?>`, 'gi'), '');

  //   html = html.replace(/<([a-zA-Z][^>]*)>\s*<\/\1>/gi, '');

  //   html = html.replace(/^\s*[\r\n]/gm, '');

  //   return html;
  // }

  write() {
    Object.values(this.files).forEach((file) => {
      let html = this.readFile(file.path);

      if (html.includes(this.metadata.cover_name)) {
        this.writeFile(file.path, html);

        Logger.info(`${this.getInfos()} - WRITE_FILE "${file.path}"`);
      } else {
        html = this.getResumeHTML(html, file);

        html = html.replace(/<br\s*\/?>/gi, '<br />');

        this.writeFile(file.path, html);

        Logger.info(`${this.getInfos()} - WRITE_FILE "${file.path}"`);
      }
      // _.remove(this.file.paths, (item) => item === file.path);
    });

    // this.file.paths.forEach((path) => {
    //   if (path.endsWith('.ncx')) {
    //     let html = this.readFile(path);

    //     html = html.replace(/<navMap>[\s\S]*?<\/navMap>/, '');

    //     html = html.replace(/<pageList>[\s\S]*?<\/pageList>/, '');

    //     html = html.replace(/^\s*[\r\n]/gm, '');

    //     this.writeFile(path, html);
    //   }

    //   if (path.endsWith('.opf')) {
    //     let html = this.readFile(path);

    //     Object.values(this.files).forEach((file) => {
    //       if (file.response) return;

    //       const info = this.getFileInfo(file.path);

    //       html = this.removeElement(html, info.id);

    //       html = this.removeElement(html, info.href);

    //       html = this.removeElement(html, info.filename);
    //     });

    //     this.writeFile(path, html);
    //   }
    // });

    this.writeEPUB();
  }

  /** **********************************************************************************************
   **                                     Translate: Request                                      **
   ********************************************************************************************** */

  secureJsonParseJSON(str, count) {
    try {
      str = str.replace('```json', '').replace('```', '');

      return JSON.parse(str.slice(str.indexOf('{'), str.lastIndexOf('}') + 1));
    } catch (error) {
      Logger.error(`${this.getInfos()} - SECURE_JSON_PARSE_JSON_${count}`, str, error);

      return undefined;
    }
  }

  parseResponseJSON(data) {
    try {
      return this.secureJsonParseJSON(data.choices[0].message.content, 1);
    } catch (error) {
      return this.secureJsonParseJSON(jsonrepair(data.choices[0].message.content, 2));
    }
  }

  async parseTranslationRequest(data, file) {
    try {
      const response = this.parseResponseJSON(data);

      if (!response.content || response.content === 'undefined') {
        if (file.count < 3) {
          file.count += 1;

          Logger.warn(`${this.getInfos()} - PARSE_TRANSLATION_REQUEST`, {
            path: file.path,
            count: file.count,
          });
        } else {
          file.finish = true;
          file.response = '<h1>X</h1>';
        }
      } else {
        file.response = await cleanHtmlForEpub(response.content)
          .then((html) => {
            file.finish = true;

            return html;
          })
          .catch((err) => {
            file.count += 1;

            if (file.count < 3) {
              file.finish = false;
              file.response = undefined;
            } else {
              file.finish = true;
              file.response = '<h1>X</h1>';
            }

            Logger.error(`${this.getInfos()} - CLEAN_HTML_FOR_EPUB`, err);
          });
      }
    } catch (error) {
      Logger.error(`${this.getInfos()} - PARSE_TRANSLATION_JSON`, data.choices);
    }
  }

  getTranslationParams(file) {
    return {
      model: this.params.model,
      messages: [
        {
          role: 'user',
          content: getContext({
            source: this.params.source,
            destination: this.params.destination,
            book_title: this.epub.metadata.title,
            book_author: this.epub.metadata.creator,
            content: file.content,
          }),
        },
      ],
    };
  }

  sendTranslationRequest(file = this.getFile()) {
    if (!file) return;

    file.waiting = true;

    OpenAI.createChatCompletion(this.getTranslationParams(file))
      .then((response) => {
        this.parseTranslationRequest(response.data, file);

        Logger.info(this.getStatus());
      })
      .catch((err) =>
        Logger.error(`${this.getInfos()} - SEND_TRANSLATION_REQUEST`, err.response?.data || err)
      )
      .finally(() => {
        file.waiting = false;
      });

    Logger.info(`${this.getInfos()} - SEND_TRANSLATION_REQUEST`);
  }

  /** **********************************************************************************************
   **                                          Translate                                          **
   ********************************************************************************************** */

  onTranslateInterval() {
    this.sendTranslationRequest();

    if (!this.hasFinish()) return;

    this.emit('translated');

    this.stopTranslateInterval();
  }

  stopTranslateInterval() {
    clearInterval(this.timers.queries.id);

    this.timers.queries.id = null;
  }

  startTranslateInterval() {
    this.stopTranslateInterval();

    this.onTranslateInterval();

    this.timers.queries.id = setInterval(() => {
      this.onTranslateInterval();
    }, this.timers.queries.interval);

    Logger.info(`${this.getInfos()} - START_TRANSLATE_INTERVAL`);
  }

  translate() {
    this.startTranslateInterval();
  }

  /** **********************************************************************************************
   **                                         Parse: HTML                                         **
   ********************************************************************************************** */

  hasUselessContent(path) {
    if (this.files[path].content.length < 2500) return true;

    if (Toolbox.countWords(this.files[path].content) < 250) return true;

    return false;
  }

  parseHTML(path) {
    this.files[path] = { path, content: '', response: null, count: 0, finish: false };

    const html = this.readFile(path);

    if (!html.includes('body')) {
      delete this.files[path];

      return;
    }

    for (let index = 0; index < html.length; index += 1) {
      if (html[index] === '>') {
        while (html[index + 1] && html[index + 1] !== '<') {
          index += 1;

          this.files[path].content += html[index];
        }
      }
    }

    this.files[path].content = this.files[path].content.replace(/\s+/g, ' ');

    if (this.hasUselessContent(path)) {
      this.files[path].response = '<h1>X</h1>';
      this.files[path].finish = true;
    }
  }

  /** **********************************************************************************************
   **                                            Parse                                            **
   ********************************************************************************************** */

  parse() {
    this.files = {};

    this.file.paths.forEach((path) => {
      if (path.endsWith('.opf')) {
        this.writeOPF(path);
      }

      if (path.endsWith(this.metadata.cover_path)) {
        this.writeCover(path);
      }

      if (this.isHTML(path)) {
        this.parseHTML(path);
      }
    });

    this.emit('parsed');
  }

  /** **********************************************************************************************
   **                                        Init: Prompt                                         **
   ********************************************************************************************** */

  promptCover() {
    const cover = this.getCover();

    if (cover) return this.setCover(cover);

    return inquirer
      .prompt([
        {
          type: 'list',
          name: 'cover',
          message: `[${new Date().toISOString()}]  PROMPT - Veuillez choisir une cover:`,
          choices: _.filter(this.epub.manifest, (el) => el['media-type'].includes('image')).map(
            (image) => ({
              name: image.href,
              value: { id: image.id, href: image.href },
            })
          ),
        },
      ])
      .then((answers) => this.setCover(answers.cover));
  }

  promptMetadata() {
    return new Promise((resolve) => {
      prompt.get(
        [
          { name: 'title', description: 'Book title', default: this.epub.metadata.title },
          { name: 'subtitle', description: 'Book subtitle', default: this.epub.metadata.subtitle },
          { name: 'creator', description: 'Book creator', default: this.epub.metadata.creator },
          { name: 'series_name', description: 'Book series name' },
          { name: 'series_volume', description: 'Book series volume' },
        ],
        (_err, result) => {
          this.metadata.title = result.title;
          this.metadata.subtitle = result.subtitle;
          this.metadata.creator = result.creator;
          this.metadata.series_name = result.series_name;
          this.metadata.series_volume = result.series_volume;

          Logger.info(`${this.getInfos()} - INIT_METADATA`, this.metadata);

          resolve();
        }
      );
    });
  }

  /** **********************************************************************************************
   **                                            Init                                             **
   ********************************************************************************************** */

  initEpub() {
    if (fs.existsSync(this.file.folder)) {
      fs.rmSync(this.file.folder, { recursive: true, force: true });
    }

    this.epub.zip.admZip.extractAllTo(this.file.folder, true);
  }

  initPaths(dirpath = this.file.folder) {
    this.file.paths ||= [];

    fs.readdirSync(dirpath).forEach((filepath) => {
      const fullpath = `${dirpath}/${filepath}`;

      return fs.statSync(fullpath).isDirectory()
        ? this.initPaths(fullpath)
        : this.file.paths.push(fullpath);
    });
  }

  init() {
    this.epub = new EPUB(this.file.path);

    this.epub.on('error', async (error) => {
      Logger.fatal(`${this.getInfos()} - INIT - ERRROR`, error);

      process.exit(-1);
    });

    this.epub.on('end', async () => {
      this.initEpub();
      this.initPaths();

      await this.promptCover();
      await this.promptMetadata();

      this.emit('initiated');
    });

    this.epub.parse();
  }
}
