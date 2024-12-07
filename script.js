import EPUB from './objects/interfaces/EPUB.js';

import Logger from './config/logger.js';

const epub = new EPUB({
  path: process.argv[2],
  source: 'Egnlish',
  destination: 'French',
});

const write = () => {
  epub.on('writed', () => {
    Logger.info('EPUB - WRITED');

    process.exit();
  });

  epub.write();
};

const translate = () => {
  epub.on('translated', () => {
    Logger.info('EPUB - TRANSLATED');

    write();
  });

  epub.translate();
};

const parse = () => {
  epub.on('parsed', () => {
    Logger.info('EPUB - PARSED');

    translate();
  });

  epub.parse();
};

const init = () => {
  epub.on('initiated', () => {
    Logger.info('EPUB - INITIATED');

    setInterval(() => Logger.info(epub.getStatus()), 5000);

    parse();
  });

  epub.init();
};

(async () => {
  init();
})();
