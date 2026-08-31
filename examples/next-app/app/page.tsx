import { Voice } from '../components/Voice';
import { hasHumeCredentials } from '../utils/get-hume-access-token';

export const dynamic = 'force-dynamic';

export default function Home() {
  if (!hasHumeCredentials()) {
    return (
      <div className={'p-6'}>
        <h1 className={'my-4 text-lg font-medium'}>Hume EVI React Example</h1>
        <div>
          Please set your HUME_API_KEY and HUME_SECRET_KEY environment variables
        </div>
      </div>
    );
  }
  const configId = process.env['HUME_CONFIG_ID'];

  return (
    <div className={'p-6'}>
      <h1 className={'my-4 text-lg font-medium'}>Hume EVI React Example</h1>
      <Voice {...(configId === undefined ? {} : { configId })} />
    </div>
  );
}
