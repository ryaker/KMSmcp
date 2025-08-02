#!/usr/bin/env node

// Quick script to enable connections for existing Auth0 client

const clientId = 'OoQIkm5QHDMPR5oA2kUvjb4mxLb6bL10';
const auth0Domain = 'https://dev-0pwckht3ptjwf0kg.us.auth0.com/';
const managementClientId = 'TJtbR6GDD3V45f15tTNf7km0JbM89QTS';
const managementClientSecret = 'WMZLuDKtv26roJpSO-tbrMnToFJ26GBQvgDbw65K-gHSxzeSGzokO5E5RUspeYwE';

async function enableConnectionForClient() {
  try {
    console.log('🔐 Getting Auth0 Management API token...');
    
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

    if (!tokenResponse.ok) {
      throw new Error(`Failed to get token: ${tokenResponse.status}`);
    }

    const { access_token } = await tokenResponse.json();
    console.log('✅ Got management token');

    // Get connections
    console.log('📋 Fetching connections...');
    const connectionsResponse = await fetch(`${auth0Domain}api/v2/connections`, {
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!connectionsResponse.ok) {
      throw new Error(`Failed to fetch connections: ${connectionsResponse.status}`);
    }

    const connections = await connectionsResponse.json();
    console.log(`📄 Found ${connections.length} connections`);

    // Find Username-Password-Authentication
    const dbConnection = connections.find(conn => 
      conn.strategy === 'auth0' && conn.name === 'Username-Password-Authentication'
    );

    if (!dbConnection) {
      throw new Error('Username-Password-Authentication connection not found');
    }

    console.log(`🔍 Found connection: ${dbConnection.name} (${dbConnection.id})`);
    console.log(`📊 Currently enabled for clients: ${JSON.stringify(dbConnection.enabled_clients || [])}`);

    // Check if client is already enabled
    if (dbConnection.enabled_clients && dbConnection.enabled_clients.includes(clientId)) {
      console.log('✅ Client already has connection enabled');
      return;
    }

    // Enable connection for client
    console.log(`🔧 Enabling connection for client ${clientId}...`);
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

    if (!enableResponse.ok) {
      const errorText = await enableResponse.text();
      throw new Error(`Failed to enable connection: ${enableResponse.status} ${errorText}`);
    }

    console.log('✅ Successfully enabled Username-Password-Authentication for client');
    console.log('🎉 OAuth flow should now work!');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

enableConnectionForClient();