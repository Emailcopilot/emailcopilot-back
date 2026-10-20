import "dotenv/config";
import nodemailer from 'nodemailer';

const smtpUrl = process.env.SMTP_URL!;
const mailerFrom = process.env.MAILER_FROM!;

// 1. Create a transporter object
const transporter = nodemailer.createTransport({
    url: smtpUrl,
});

// 2. Configure the email options
const mailOptions = {
    from: mailerFrom,
    to: mailerFrom,
    subject: 'Hello from Nodemailer!',
    text: 'This is a test email sent using Nodemailer.',
};

// 3. Send the email
transporter.sendMail(mailOptions, async (error, info) => {
    if (error) {
        return console.log('Error:', error);
    }
    console.log('Email sent:', info.response);

    const url = nodemailer.getTestMessageUrl(info);
    console.log('Test email URL:', url);
});
