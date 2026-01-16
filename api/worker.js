module.exports = async function handler(job) {
  // Get the role and global business info
  const role = job.agent_role;
  const globalInfo = job.global_business_info; // This is the shared info all agents need.
  
  // Get all the possible role configs
  const dispatchConfig = job.dispatch_config;
  const schedulerConfig = job.scheduler_config;
  const intakeConfig = job.intake_config;
  const leadRevivalConfig = job.lead_revival_config;
  
  // Default to the receptionist role
  let roleConfig = globalInfo; // Start with global info as a base
  
  // Add the specific role config based on the agent's role
  if (role === 'emergency_dispatch') {
    roleConfig += "\n\n" + dispatchConfig;
  } else if (role === 'scheduler') {
    roleConfig += "\n\n" + schedulerConfig;
  } else if (role === 'intake') {
    roleConfig += "\n\n" + intakeConfig;
  } else if (role === 'lead_revival') {
    roleConfig += "\n\n" + leadRevivalConfig;
  } else if (role === 'operations') {
    // For operations, combine all configs
    roleConfig += "\n\n" + dispatchConfig + "\n\n" + schedulerConfig + "\n\n" + intakeConfig + "\n\n" + leadRevivalConfig;
  }

  // Now you have the final roleConfig which includes global info plus the role-specific details
  // You can now proceed with the agent creation using roleConfig

  // ... rest of your agent creation logic ...
};
