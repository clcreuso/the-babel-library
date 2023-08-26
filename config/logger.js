import log4js from 'log4js';

log4js.configure({
  appenders: {
    server: {
      type: 'console',
      filename: 'logs/server.log',
      layout: { type: 'pattern', pattern: '%[[%d] %5.5p -%] %m' },
    },
  },
  categories: { default: { appenders: ['server'], level: 'all' } },
});

export default log4js.getLogger();
