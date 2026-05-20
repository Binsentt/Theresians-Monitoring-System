const nodemailer = require('nodemailer');
const { buildEmailTransportConfig } = require('./emailTransport.utils');

const firstPresent = (...values) => values.find((value) => String(value || '').trim() !== '');

const smtpUser = firstPresent(
  process.env.SMTP_USER,
  process.env.SMTP_USERNAME,
  process.env.MAIL_USER
);
const smtpPass = firstPresent(
  process.env.SMTP_PASS,
  process.env.SMTP_PASSWORD,
  process.env.MAIL_PASS
);
const senderEmail = firstPresent(
  process.env.EMAIL_FROM,
  process.env.MAIL_FROM,
  process.env.EMAIL_USER,
  smtpUser
);

if (!process.env.EMAIL_USER && senderEmail) process.env.EMAIL_USER = senderEmail;
if (!process.env.EMAIL_PASS && smtpPass) process.env.EMAIL_PASS = smtpPass;

const transportConfig = buildEmailTransportConfig(process.env);

if (transportConfig.enabled && transportConfig.options && transportConfig.options.host) {
  const createTransport = nodemailer.createTransport.bind(nodemailer);
  nodemailer.createTransport = (_options, defaults) => createTransport(transportConfig.options, defaults);
}
