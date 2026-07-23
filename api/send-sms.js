const twilio = require("twilio");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
    });
  }
  try {
    // Retell custom functions normally send:
    // {
    //   name: "send_customer_text",
    //   call: { from_number, call_id, ... },
    //   args: { client_id, message_type }
    // }

    const body = req.body || {};
    const args = body.args || body;
    const call = body.call || {};

    const callerPhone =
      call.from_number ||
      args.caller_phone ||
      args.phone_number;

    const clientId = args.client_id;
    const messageType = args.message_type;

    if (!callerPhone) {
      return res.status(400).json({
        success: false,
        error: "Caller phone number is missing",
      });
    }

    if (!clientId) {
      return res.status(400).json({
        success: false,
        error: "Client ID is missing",
      });
    }

    if (!messageType) {
      return res.status(400).json({
        success: false,
        error: "Message type is missing",
      });
    }

    /*
      For now, place the approved client links here.

      Later, we can pull these values from your Client Config
      sheet or database instead of storing them directly in code.
    */
    const clientConfig = {
      sarah_medicare: {
        businessName: "Sarah's Medicare Office",

        messages: {
          enrollment_link: {
            link: "https://REPLACE-WITH-SARAHS-SECURE-LINK.com",

            createBody: function ({ businessName, link }) {
              return (
                `Here is the secure enrollment link you requested from ` +
                `${businessName}: ${link} Reply STOP to opt out.`
              );
            },
          },
        },
      },

      /*
      Add another broker like this:

      len_medicare: {
        businessName: "Len's Medicare Office",

        messages: {
          enrollment_link: {
            link: "https://REPLACE-WITH-LENS-LINK.com",

            createBody: function ({ businessName, link }) {
              return (
                `Here is the secure enrollment link you requested from ` +
                `${businessName}: ${link} Reply STOP to opt out.`
              );
            },
          },
        },
      },
      */
    };

    const client = clientConfig[clientId];

    if (!client) {
      return res.status(400).json({
        success: false,
        error: `Unknown client ID: ${clientId}`,
      });
    }

    const messageConfig = client.messages[messageType];

    if (!messageConfig) {
      return res.status(400).json({
        success: false,
        error: `Message type "${messageType}" is not configured for this client`,
      });
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;

    if (!accountSid || !authToken || !twilioPhoneNumber) {
      console.error("Missing Twilio environment variables");

      return res.status(500).json({
        success: false,
        error: "SMS service is not configured",
      });
    }

    const messageBody = messageConfig.createBody({
      businessName: client.businessName,
      link: messageConfig.link,
    });

    const twilioClient = twilio(accountSid, authToken);

    const message = await twilioClient.messages.create({
      body: messageBody,
      from: twilioPhoneNumber,
      to: callerPhone,
    });

    console.log("SMS sent successfully", {
      messageSid: message.sid,
      clientId,
      messageType,
      callerPhone,
      callId: call.call_id || null,
    });

    return res.status(200).json({
      success: true,
      message: "Text message sent successfully",
      message_sid: message.sid,
      sent_to: callerPhone,

      // Retell can use this response to decide what the agent says.
      agent_response:
        "The text was sent successfully. Confirm to the caller that it has been sent.",
    });
  } catch (error) {
    console.error("SMS sending error:", {
      message: error.message,
      code: error.code,
      status: error.status,
    });

    return res.status(500).json({
      success: false,
      error: "The text message could not be sent",
      agent_response:
        "The text could not be sent. Apologize and offer to verify the caller's mobile number.",
    });
  }
};
