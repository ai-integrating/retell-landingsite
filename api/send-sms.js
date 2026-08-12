// /api/send-sms.js
const twilio = require("twilio");
const { kv } = require("@vercel/kv");

function clean(value) {
  return String(value ?? "").trim();
}

function normalizePhone(value) {
  const phone = clean(value);

  if (/^\+\d{10,15}$/.test(phone)) {
    return phone;
  }

  const digits = phone.replace(/\D/g, "");

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length >= 11 && digits.length <= 15) {
    return `+${digits}`;
  }

  return "";
}

function normalizeEmail(value) {
  return clean(value).toLowerCase().replace(/\s+/g, "");
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function createMessageBody({
  businessName,
  messageType,
  link,
}) {
  switch (messageType) {
    case "scope_of_appointment":
      return (
        `Here is the Scope of Appointment from ${businessName}: ` +
        `${link} Reply STOP to opt out.`
      );

    case "enrollment_link":
      return (
        `Here is the secure enrollment link you requested from ` +
        `${businessName}: ${link} Reply STOP to opt out.`
      );

    case "booking_link":
      return (
        `Here is the scheduling link you requested from ` +
        `${businessName}: ${link} Reply STOP to opt out.`
      );

    case "website":
      return (
        `Here is the website for ${businessName}: ` +
        `${link} Reply STOP to opt out.`
      );

    case "photo_upload_link":
      return (
        `Here is the link to upload your photos for ` +
        `${businessName}: ${link} Reply STOP to opt out.`
      );

    case "financing_link":
      return (
        `Here is the financing link you requested from ` +
        `${businessName}: ${link} Reply STOP to opt out.`
      );

    default:
      throw new Error(
        `Unsupported message type: ${messageType}`
      );
  }
}

function createEmailContent({
  businessName,
  messageType,
  link,
}) {
  switch (messageType) {
    case "scope_of_appointment":
      return {
        subject: `Scope of Appointment from ${businessName}`,
        text:
          `Here is your Scope of Appointment from ${businessName}:\n\n` +
          `${link}\n\n` +
          `Please complete it before your appointment.`,
        html:
          `<p>Here is your Scope of Appointment from ${businessName}.</p>` +
          `<p><a href="${link}">Open Scope of Appointment</a></p>` +
          `<p>Please complete it before your appointment.</p>`,
      };

    case "enrollment_link":
      return {
        subject: `Secure enrollment link from ${businessName}`,
        text:
          `Here is the secure enrollment link you requested from ${businessName}:\n\n${link}`,
        html:
          `<p>Here is the secure enrollment link you requested from ${businessName}.</p>` +
          `<p><a href="${link}">Open secure enrollment link</a></p>`,
      };

    case "booking_link":
      return {
        subject: `Scheduling link from ${businessName}`,
        text:
          `Here is the scheduling link you requested from ${businessName}:\n\n${link}`,
        html:
          `<p>Here is the scheduling link you requested from ${businessName}.</p>` +
          `<p><a href="${link}">Schedule an appointment</a></p>`,
      };

    case "website":
      return {
        subject: `${businessName} website`,
        text: `Here is the website for ${businessName}:\n\n${link}`,
        html:
          `<p>Here is the website for ${businessName}.</p>` +
          `<p><a href="${link}">Visit website</a></p>`,
      };

    case "photo_upload_link":
      return {
        subject: `Photo upload link from ${businessName}`,
        text:
          `Here is the link to upload your photos for ${businessName}:\n\n${link}`,
        html:
          `<p>Here is the link to upload your photos for ${businessName}.</p>` +
          `<p><a href="${link}">Upload photos</a></p>`,
      };

    case "financing_link":
      return {
        subject: `Financing link from ${businessName}`,
        text:
          `Here is the financing link you requested from ${businessName}:\n\n${link}`,
        html:
          `<p>Here is the financing link you requested from ${businessName}.</p>` +
          `<p><a href="${link}">Open financing link</a></p>`,
      };

    default:
      throw new Error(
        `Unsupported message type: ${messageType}`
      );
  }
}

async function getAgentLink(agentId, messageType) {
  const supportedKeys = {
    scope_of_appointment:
      `agent:${agentId}:scope_of_appointment_link`,

    enrollment_link:
      `agent:${agentId}:enrollment_link`,

    booking_link:
      `agent:${agentId}:booking_link`,

    website:
      `agent:${agentId}:website`,

    photo_upload_link:
      `agent:${agentId}:photo_upload_link`,

    financing_link:
      `agent:${agentId}:financing_link`,
  };

  const key = supportedKeys[messageType];

  if (!key) {
    throw new Error(
      `Unsupported message type: ${messageType}`
    );
  }

  return clean(await kv.get(key));
}

async function sendEmailWithResend({
  to,
  subject,
  text,
  html,
}) {
  const apiKey = clean(process.env.RESEND_API_KEY);
  const from = clean(process.env.EMAIL_FROM);

  if (!apiKey || !from) {
    throw new Error("Email service is not configured");
  }

  const response = await fetch(
    "https://api.resend.com/emails",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to,
        subject,
        text,
        html,
      }),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data?.message ||
        data?.error ||
        `Resend request failed with status ${response.status}`
    );
  }

  return data;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
    });
  }

  try {
    const body = req.body || {};
    const args = body.args || body;
    const call = body.call || {};

    const deliveryMethod = clean(
      args.delivery_method ||
        body.delivery_method ||
        "sms"
    ).toLowerCase();

    if (!["sms", "email"].includes(deliveryMethod)) {
      return res.status(400).json({
        success: false,
        error: "Invalid delivery method",
        agent_response:
          "Please choose text or email.",
      });
    }

    // Explicit number supplied by Ava takes priority.
    const recipientPhone = normalizePhone(
      args.phone_number ||
        args.phone ||
        args.recipient_phone ||
        args.caller_phone ||
        call.from_number ||
        call.caller_number
    );

    const recipientEmail = normalizeEmail(
      args.email ||
        args.recipient_email ||
        body.email
    );

    const agentId = clean(
      call.agent_id ||
        body.agent_id ||
        args.agent_id ||
        body?.data?.agent_id
    );

    const messageType = clean(
      args.message_type ||
        body.message_type ||
        "enrollment_link"
    );

    if (!agentId) {
      return res.status(400).json({
        success: false,
        error: "Agent ID is missing",
        agent_response:
          "I could not identify the business configuration for this call.",
      });
    }

    const clientId = clean(
      await kv.get(`agent:${agentId}:client`)
    );

    if (!clientId) {
      return res.status(404).json({
        success: false,
        error: `No client mapping found for agent ID: ${agentId}`,
        agent_response:
          "I could not locate the business configuration.",
      });
    }

    const businessName =
      clean(
        await kv.get(
          `agent:${agentId}:business_name`
        )
      ) || "the business";

    // Allow an explicit link from the tool, otherwise use KV.
    const link =
      clean(args.link || body.link) ||
      (await getAgentLink(
        agentId,
        messageType
      ));

    if (!link) {
      return res.status(400).json({
        success: false,
        error:
          `${messageType} is not configured for agent ` +
          `${agentId}`,
        agent_response:
          "That link has not been configured for this business yet.",
      });
    }

    // -------------------- SMS --------------------
    if (deliveryMethod === "sms") {
      if (!recipientPhone) {
        return res.status(400).json({
          success: false,
          error:
            "Recipient phone number is missing or invalid",
          agent_response:
            "I could not identify a valid mobile number. Ask for another mobile number or offer email.",
        });
      }

      const accountSid =
        process.env.TWILIO_ACCOUNT_SID;

      const authToken =
        process.env.TWILIO_AUTH_TOKEN;

      const twilioPhoneNumber =
        normalizePhone(
          process.env.TWILIO_PHONE_NUMBER
        );

      if (
        !accountSid ||
        !authToken ||
        !twilioPhoneNumber
      ) {
        return res.status(500).json({
          success: false,
          error: "SMS service is not configured",
          agent_response:
            "The texting service is unavailable right now. Offer email instead.",
        });
      }

      const messageBody = createMessageBody({
        businessName,
        messageType,
        link,
      });

      const twilioClient = twilio(
        accountSid,
        authToken
      );

      const message =
        await twilioClient.messages.create({
          body: messageBody,
          from: twilioPhoneNumber,
          to: recipientPhone,
        });

      console.log("SMS sent successfully", {
        messageSid: message.sid,
        agentId,
        clientId,
        businessName,
        messageType,
        recipientPhone,
        callId: call.call_id || null,
      });

      return res.status(200).json({
        success: true,
        delivery_method: "sms",
        sms_successful: true,
        message:
          "Text message sent successfully",
        message_sid: message.sid,
        sent_to: recipientPhone,
        client_id: clientId,
        business_name: businessName,
        message_type: messageType,
        agent_response:
          "The text was sent successfully. Confirm that it has been sent.",
      });
    }

    // -------------------- EMAIL --------------------
    if (deliveryMethod === "email") {
      if (!isValidEmail(recipientEmail)) {
        return res.status(400).json({
          success: false,
          error:
            "Recipient email is missing or invalid",
          agent_response:
            "I could not identify a valid email address. Verify the email or offer text instead.",
        });
      }

      const emailContent =
        createEmailContent({
          businessName,
          messageType,
          link,
        });

      const emailResult =
        await sendEmailWithResend({
          to: recipientEmail,
          subject: emailContent.subject,
          text: emailContent.text,
          html: emailContent.html,
        });

      console.log("Email sent successfully", {
        emailId: emailResult?.id || null,
        agentId,
        clientId,
        businessName,
        messageType,
        recipientEmail,
        callId: call.call_id || null,
      });

      return res.status(200).json({
        success: true,
        delivery_method: "email",
        email_successful: true,
        message:
          "Email sent successfully",
        email_id: emailResult?.id || null,
        sent_to: recipientEmail,
        client_id: clientId,
        business_name: businessName,
        message_type: messageType,
        agent_response:
          "The email was sent successfully. Confirm that it has been sent.",
      });
    }
  } catch (error) {
    console.error("Message delivery error:", {
      message: error?.message,
      code: error?.code,
      status: error?.status,
      stack: error?.stack,
    });

    return res.status(500).json({
      success: false,
      error:
        "The message could not be delivered",
      details:
        error?.message || "Unknown error",
      agent_response:
        "The message could not be sent. Apologize, verify the contact information, or offer the other delivery method.",
    });
  }
};
