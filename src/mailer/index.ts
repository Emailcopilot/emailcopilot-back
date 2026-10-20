import nodemailer from 'nodemailer';
import { MAILER_FROM, SMTP_URL } from '../lib/env';
import fs from 'fs';
import path from 'path';

const transporter = nodemailer.createTransport({
    url: SMTP_URL,
});

export default transporter;

export const sendEmail = async (
    to: string,
    subject: string,
    html: string,
    attachments?: nodemailer.SendMailOptions['attachments'],
) => {
    const mailOptions = {
        from: MAILER_FROM,
        to,
        subject,
        html,
        attachments,
    };
    const info = await transporter.sendMail(mailOptions);
    const url = nodemailer.getTestMessageUrl(info);
    console.log('Test email URL:', url);
};

const BASE_MAIL_TEMPLATE = 'base-mail.html';
const LOGO_FILE = 'logo.png';
const LOGO_CID = 'logo';

function mailAssetPath(filename: string) {
    const candidates = [
        path.join(__dirname, 'templates', filename),
        path.join(process.cwd(), 'src', 'mailer', 'templates', filename),
    ];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) {
        throw new Error(`Mail asset not found: ${filename}`);
    }
    return found;
}

type TemplateName = 'copilot-landed'

export async function renderBaseMail(templateName: TemplateName, data: TemplateData) {
    const baseTemplate = await fs.promises.readFile(mailAssetPath(BASE_MAIL_TEMPLATE), 'utf8');
    const template = await fs.promises.readFile(mailAssetPath(`${templateName}.html`), 'utf8');
    return baseTemplate.replace('{{body}}', () => template.replace(/{{(.*?)}}/g, (match, p1) => data[p1] || match));
}

type TemplateData = Record<string, string>;

export const sendTemplateEmail = async (to: string, subject: string, templateName: TemplateName, data: TemplateData) => {
    const html = await renderBaseMail(templateName, data);
    await sendEmail(to, subject, html, [
        {
            filename: LOGO_FILE,
            path: mailAssetPath(LOGO_FILE),
            cid: LOGO_CID,
        },
    ]);
};