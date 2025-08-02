#!/usr/bin/env node

// Enable connection for the newly created client
const clientId = 'D1dwljqoaIuk47PMR8qnpTbl4eGHrsei';
const auth0Domain = 'https://dev-0pwckht3ptjwf0kg.us.auth0.com/';
const managementClientId = 'TJtbR6GDD3V45f15tTNf7km0JbM89QTS';
const managementClientSecret = 'WMZLuDKtv26roJpSO-tbrMnToFJ26GBQvgDbw65K-gHSxzeSGzokO5E5RUspeYwE';

async function enableConnection() {
  try {
    // Get management token
    const tokenResponse = await fetch(`${auth0Domain}oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: managementClientId,
        client_secret: managementClientSecret,
        audience: `${auth0Domain}api/v2/`,
        grant_type: 'client_credentials'
      })
    });

    const { access_token } = await tokenResponse.json();

    // Get connections
    const connectionsResponse = await fetch(`${auth0Domain}api/v2/connections`, {
      headers: { 'Authorization': `Bearer ${access_token}` }
    });

    const connections = await connectionsResponse.json();
    const dbConnection = connections.find(conn => 
      conn.strategy === 'auth0' && conn.name === 'Username-Password-Authentication'
    );

    // Enable connection
    const enableResponse = await fetch(`${auth0Domain}api/v2/connections/${dbConnection.id}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        enabled_clients: [...(dbConnection.enabled_clients || []), clientId]
      })
    });

    console.log(`✅ Enabled connection for ${clientId}: ${enableResponse.ok}`);
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

enableConnection();