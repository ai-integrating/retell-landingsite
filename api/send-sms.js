const twilio = require("twilio");
const { google } = require("googleapis");

const SPREADSHEET_ID =
  process.env.CLIENT_CONFIG_SHEET_ID ||
  "1BVn3KetFMqJjN1FhG5NC-zOMPcV9v1m4Y8plTdtjeSI";

const SHEET_NAME = "Sheet1";

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeHeader(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
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

function getGoogleCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const credentials = JSON.parse(
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    );

    credentials.private_key = clean(credentials.private_key)
      .replace(/\\n/g, "\n");

    return credentials;
  }

  if (
    process.env.GOOGLE_CLIENT_EMAIL &&
    process.env.GOOGLE_PRIVATE_KEY
  ) {
    return {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(
        /\\n/g,
        "\n"
      ),
    };
  }

  throw new Error("Google credentials are missing");
}

async function readClientConfig() {
  const credentials = getGoogleCredentials();

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets.readonly",
    ],
  });

  const sheets = google.sheets({
    version: "v4",
    auth,
  });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:ZZ`,
  });

  const values = response.data.values || [];

  if (values.length < 2) {
    return [];
  }

  const headers = values[0].map(normalizeHeader);

  return values.slice(1).map((row) => {
    const record = {};

    headers.forEach((header, index) => {
      if (header) {
        record[header] = clean(row[index]);
      }
    });

    return record;
  });
}

function getMessageLink(client, messageType) {
  const links = {
    booking_link:
      client.booking_link ||
      client.scheduling_link ||
      client.calendar_link,

    enrollment_link:
      client.enrollment_link ||
      client.enrollment_url ||
      client.secure_enrollment_link,

    website:
      client.website ||
      client.website_link,

    photo_upload_link:
      client.photo_upload_link ||
      client.upload_link,

    financing_link:
      client.financing_link ||
      client.finance_link,
  };

  return clean(links[messageType]);
}

function createMessageBody({
  businessName,
  messageType,
  link,
}) {
  switch (messageType) {
    case "booking_link":
      return (
        `Here is the scheduling link you requested from ` +
        `${businessName}: ${link} Reply STOP to opt out.`
      );

    case "enrollment_link":
      return (
        `Here is the secure enrollment link you requested from ` +
        `${businessName}: ${link} Reply STOP to opt out.`
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

    case "website":
      return (
        `Here is the website for ${businessName}: ` +
        `${link} Reply STOP to opt out.`
      );

    default:
      throw new Error(
        `Unsupported message type: ${messageType}`
      );
  }
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

    const callerPhone = normalizePhone(
      call.from_number ||
        call.caller_number ||
        args.caller_phone ||
        args.phone_number
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
        "booking_link"
    );

    if (!callerPhone) {
      return res.status(400).json({
        success: false,
        error: "Caller phone number is missing or invalid",
        agent_response:
          "I could not identify a valid mobile number for the caller.",
      });
    }

    if (!agentId) {
      return res.status(400).json({
        success: false,
        error: "Agent ID is missing",
        agent_response:
          "I could not identify the business configuration for this call.",
      });
    }

    const clients = await readClientConfig();

    const client = clients.find(
      (row) => clean(row.agent_id) === agentId
    );

    if (!client) {
      return res.status(404).json({
        success: false,
        error: `No Client Config row found for agent ID: ${agentId}`,
        agent_response:
          "I could not locate the business texting configuration.",
      });
    }

    const clientId = clean(client.client_id);
    const businessName =
      clean(client.business_name) || "the business";

    const link = getMessageLink(client, messageType);

    if (!link) {
      return res.status(400).json({
        success: false,
        error: `${messageType} is not configured for ${businessName}`,
        agent_response:
          "That link has not been configured for this business yet.",
      });
    }

    const accountSid =
      process.env.TWILIO_ACCOUNT_SID;

    const authToken =
      process.env.TWILIO_AUTH_TOKEN;

    const twilioPhoneNumber = normalizePhone(
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
          "The texting service is unavailable right now.",
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
        to: callerPhone,
      });

    console.log("SMS sent successfully", {
      messageSid: message.sid,
      agentId,
      clientId,
      businessName,
      messageType,
      callerPhone,
      callId: call.call_id || null,
    });

    return res.status(200).json({
      success: true,
      message: "Text message sent successfully",
      message_sid: message.sid,
      sent_to: callerPhone,
      client_id: clientId,
      business_name: businessName,
      message_type: messageType,
      agent_response:
        "The text was sent successfully. Confirm that it has been sent.",
    });
  } catch (error) {
    console.error("SMS sending error:", {
      message: error?.message,
      code: error?.code,
      status: error?.status,
      stack: error?.stack,
    });

    return res.status(500).json({
      success: false,
      error: "The text message could not be sent",
      details: error?.message || "Unknown error",
      agent_response:
        "The text could not be sent. Apologize and offer to verify the caller's mobile number.",
    });
  }
};
