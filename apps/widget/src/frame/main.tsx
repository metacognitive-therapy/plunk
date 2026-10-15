import {render} from 'preact';

import {App} from './App';
import {type HostBridge, connectToHost} from './host';
import {standaloneVisitorId} from './visitor';
import './styles.css';

const params = new URLSearchParams(window.location.search);
const root = document.getElementById('root');
const publicKey = params.get('key') ?? '';

function mount(visitorId: string, bridge?: HostBridge, userToken?: string) {
  if (root) {
    render(<App publicKey={publicKey} visitorId={visitorId} bridge={bridge} userToken={userToken} />, root);
  }
}

if (params.get('embed') === '1') {
  connectToHost(params.get('parent'), mount);
} else {
  mount(standaloneVisitorId());
}
