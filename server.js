// server.js
require('dotenv').config(); // Load environment variables from .env
const express = require('express');
const axios = require('axios');
const app = express();

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const RETELL_API_KEY = process.env.RETELL_API_KEY; 
const AGENT_ID = process.env.AGENT_ID; 

// !!! CRITICAL FIX: Ensure the V2 endpoint for creating a web call is used !!!
const RETELL_API_URL = 'https://api.retellai.com/v2/create-web-call'; 

// --- Middleware ---
// Allows Express to parse JSON bodies from POST requests
app.use(express.json()); 

// --- Retell Call Creation Endpoint ---
app.post('/api/retell-create-call', async (req, res) => {
    
    // 1. Configuration check
    if (!RETELL_API_KEY || !AGENT_ID) {
        console.error("Configuration Error: RETELL_API_KEY or AGENT_ID is missing. Check your .env file.");
        return res.status(500).json({ error: 'Server key configuration error. Please ensure .env file is correct.' });
    }

    try {
        console.log(`Attempting to create web call for agent: ${AGENT_ID} using URL: ${RETELL_API_URL}`);
        
        // 2. Call the Retell API securely from the backend (using Axios)
        const response = await axios.post(RETELL_API_URL, 
            {
                agent_id: AGENT_ID,
            },
            {
                // Authorization header is used to pass the secret API key
                headers: {
                    'Authorization': `Bearer ${RETELL_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        // 3. Retell's 'create-web-call' API returns an 'access_token'
        const { access_token, call_id } = response.data;

        if (!access_token) {
            throw new Error('Retell API did not return an access_token.');
        }

        // Success: Return the access_token (and call_id for tracking) to the client
        console.log(`Successfully generated access_token. Call ID: ${call_id}`);
        res.status(200).json({ access_token, call_id });

    } catch (error) {
        // --- Improved Error Logging ---
        let errorMessage = 'An unknown error occurred.';
        
        if (error.response) {
            // Check if Retell returned an error message in JSON (preferred) or HTML (as seen)
            errorMessage = error.response.data.error || error.response.data || error.response.statusText;
        } else {
            errorMessage = error.message;
        }

        console.error('Error creating Retell call:', errorMessage);
        
        // Return a generic error to the client
        res.status(500).json({ 
            error: 'Failed to initialize call service. Check server console logs for details.' 
        });
    }
});

// --- Server Startup ---
app.listen(PORT, () => {
    console.log(`\n============================================`);
    console.log(`🚀 Retell Proxy API running at http://localhost:${PORT}`);
    console.log(`✅ Use this POST URL in Postman: http://localhost:${PORT}/api/retell-create-call`);
    console.log(`============================================\n`);
});