sudo tee /srv/ticket_server/test_email.js >/dev/null <<'JS'
const nodemailer = require("nodemailer");
require("dotenv").config({ path: "/srv/ticket_server/.env" });

(async () => {
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: (process.env.SMTP_SECURE || "false") === "true", // false for STARTTLS (port 587)
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    const info = await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.SMTP_USER, // send to yourself
      subject: "✅ Outlook SMTP Test from Ticket Server",
      text: "This is a test email sent using Outlook SMTP configuration.",
    });

    console.log("✅ Email sent successfully:", info.messageId);
  } catch (err) {
    console.error("❌ Error sending email:", err.message);
  }
})();
JS