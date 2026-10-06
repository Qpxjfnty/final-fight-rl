import {networkInterfaces} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';

const root=fileURLToPath(new URL('..',import.meta.url));
const port=5174;
let localName='';
if(process.platform==='darwin') {
  try {localName=execFileSync('/usr/sbin/scutil',['--get','LocalHostName'],{encoding:'utf8'}).trim();} catch {}
}
const host=localName?`${localName.toLowerCase()}.local`:'';
const addresses=[...new Set(Object.values(networkInterfaces()).flat().filter(info=>info&&info.family==='IPv4'&&!info.internal).map(info=>info.address))];
const urls=[...addresses.map(address=>`http://${address}:${port}/`),...(host?[`http://${host}:${port}/`]:[])];

function showLinks() {
  console.log('\nFinal Fight RL — iPad playtest\n');
  console.log('On your iPad, connect to the same Wi-Fi and open Safari:');
  urls.forEach(url=>console.log(`  ${url}`));
  if(!urls.length)console.log('  No network address found. Connect this Mac to Wi-Fi and restart.');
  console.log('\nKeep this Mac on, its lid open, and this window running.');
  console.log('Refresh Safari after game changes. Ctrl+C stops this preview.\n');
}

const server=await createServer({root,server:{host:'0.0.0.0',port,strictPort:true,allowedHosts:host?[host,`${localName}.local`]:[]}});
try {
  await server.listen();
  showLinks();
} catch(error) {
  await server.close();
  if(String(error).includes('already in use')) {
    // Reopening the launcher should reuse the running preview instead of changing its address.
    let existingGame=false;
    try {const response=await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(1500)});existingGame=response.ok&&(await response.text()).includes('<title>Final Fight RL');} catch {}
    if(existingGame){showLinks();console.log('The playtest server is already running in another window.');process.exit(0);}
  }
  console.error(`Could not start the iPad preview: ${error.message}`);
  process.exit(1);
}

for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await server.close();process.exit(0);});
