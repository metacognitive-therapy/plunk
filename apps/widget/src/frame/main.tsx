import {render} from 'preact';

import {App} from './App';
import {standaloneVisitorId} from './visitor';
import './styles.css';

const params = new URLSearchParams(window.location.search);
const root = document.getElementById('root');

if (root) {
  render(<App publicKey={params.get('key') ?? ''} visitorId={standaloneVisitorId()} />, root);
}
