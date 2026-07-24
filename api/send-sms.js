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

function createMessageBody({
  businessName,
  messageType,
  link,
}) {
  switch (messageType) {
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

async function getAgentLink(agentId, messageType) {
  const supportedKeys = {
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
        "enrollment_link"
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

    const clientId = clean(
      await kv.get(`agent:${agentId}:client`)
    );

    if (!clientId) {
      return res.status(404).json({
        success: false,
        error: `No client mapping found for agent ID: ${agentId}`,
        agent_response:
          "I could not locate the business texting configuration.",
      });
    }

    const businessName =
      clean(
        await kv.get(
          `agent:${agentId}:business_name`
        )
      ) || "the business";

    const link = await getAgentLink(
      agentId,
      messageType
    );

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
