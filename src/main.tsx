import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { consumeRecoveryCallback, PasswordRecovery } from './components/PasswordRecovery';
import './index.css';

function Root() {
  const [recovery, setRecovery] = useState(consumeRecoveryCallback);
  const [returnToPortal, setReturnToPortal] = useState(false);

  if (recovery) {
    return <PasswordRecovery {...recovery} onReturn={() => {
      setRecovery(null);
      setReturnToPortal(true);
    }} />;
  }

  return <App initialRoute={returnToPortal ? 'portals' : 'home'} />;
}

createRoot(document.getElementById('root')!).render(<Root />);
