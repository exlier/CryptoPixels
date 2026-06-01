#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const envPath = path.resolve(__dirname, '..', '.env');
const projectRef = process.env.SUPABASE_PROJECT_REF;
const managementToken = process.env.SUPABASE_MANAGEMENT_TOKEN;
const managementUrl = process.env.SUPABASE_MANAGEMENT_URL || 'https://api.supabase.com';

function readEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .reduce((acc, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return acc;
      const [key, ...rest] = trimmed.split('=');
      acc[key] = rest.join('=');
      return acc;
    }, {});
}

function writeEnv(filePath, vars) {
  const lines = Object.entries(vars).map(([key, value]) => `${key}=${value}`);
  fs.writeFileSync(filePath, lines.join('\n') + '\n', { encoding: 'utf8' });
}

function updateEnvKey(key, value) {
  const env = readEnv(envPath);
  env[key] = value;
  writeEnv(envPath, env);
}

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function rotateWithCli() {
  if (!commandExists('supabase')) {
    throw new Error('Supabase CLI is not installed. Install it before attempting service key rotation.');
  }

  if (!projectRef) {
    throw new Error('SUPABASE_PROJECT_REF is required in environment to rotate the service key with the CLI.');
  }

  console.log('Rotating service key using Supabase CLI...');

  // NOTE: adjust this command if your installed Supabase CLI exposes a different rotation action.
  const output = execSync(`supabase projects rotate-service-role-key --project-ref ${projectRef}`, {
    encoding: 'utf8',
  }).trim();

  const match = output.match(/service role key:?\s*([A-Za-z0-9-_]+)$/i);
  if (!match) {
    throw new Error(`Unable to parse rotated key from Supabase CLI output:\n${output}`);
  }
  return match[1];
}

async function rotateWithManagementApi() {
  if (!projectRef || !managementToken) {
    throw new Error('SUPABASE_PROJECT_REF and SUPABASE_MANAGEMENT_TOKEN are required for management API rotation.');
  }

  const url = new URL(`${managementUrl}/v1/projects/${projectRef}/service-role/rotate`);
  const https = require('https');

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${managementToken}`,
          'Content-Type': 'application/json',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Supabase management API rotation failed: ${res.statusCode} ${body}`));
          }
          try {
            const data = JSON.parse(body);
            if (!data?.service_role_key) {
              return reject(new Error(`Unexpected response from management API: ${body}`));
            }
            resolve(data.service_role_key);
          } catch (err) {
            reject(new Error(`Failed to parse management API response: ${err.message}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.end();
  });
}

(async () => {
  try {
    let newServiceKey = null;

    if (commandExists('supabase')) {
      newServiceKey = rotateWithCli();
    } else {
      newServiceKey = await rotateWithManagementApi();
    }

    updateEnvKey('SUPABASE_SERVICE_KEY', newServiceKey);
    console.log('SUPABASE_SERVICE_KEY updated successfully in .env');
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
})();
