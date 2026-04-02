async function bindPhoneNumberToAgent({ phoneData, agentId }) {
  const phoneNumber = phoneData.phone_number || phoneData.e164 || phoneData.number || null;
  const phoneId = phoneData.phone_number_id || phoneData.id || null;
  const bindingPayload = buildAgentBindingPayload(agentId);

  let firstErr = null;

  if (phoneNumber) {
    try {
      await axios.patch(
        `${RETELL_BASE}/update-phone-number/${encodeURIComponent(phoneNumber)}`,
        bindingPayload,
        { headers: retellHeaders(), timeout: 7000 }
      );
      return { phone_number: phoneNumber, phone_number_id: phoneId || null };
    } catch (err) {
      firstErr = err;
      console.error(
        "PATCH by phone_number failed:",
        err?.response?.data || err?.message || err
      );
    }
  }

  if (phoneId) {
    try {
      await axios.patch(
        `${RETELL_BASE}/update-phone-number/${encodeURIComponent(phoneId)}`,
        bindingPayload,
        { headers: retellHeaders(), timeout: 7000 }
      );
      return { phone_number: phoneNumber || "(assigned)", phone_number_id: phoneId };
    } catch (err) {
      console.error(
        "PATCH by phone_id failed:",
        err?.response?.data || err?.message || err
      );
      throw err;
    }
  }

  throw new Error(
    `Could not bind phone number. patch_error=${
      JSON.stringify(firstErr?.response?.data || firstErr?.message || null)
    } phoneData=${JSON.stringify(phoneData)}`
  );
}
