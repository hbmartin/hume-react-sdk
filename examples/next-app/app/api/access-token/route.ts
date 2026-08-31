import {
  getHumeAccessToken,
  MissingHumeCredentialsError,
} from '../../../utils/get-hume-access-token';

const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store',
};

export async function POST() {
  try {
    return Response.json(await getHumeAccessToken(), {
      headers: PRIVATE_NO_STORE_HEADERS,
    });
  } catch (error) {
    if (error instanceof MissingHumeCredentialsError) {
      return Response.json(
        {
          error:
            'The server is missing HUME_API_KEY or HUME_SECRET_KEY configuration.',
        },
        { status: 503, headers: PRIVATE_NO_STORE_HEADERS },
      );
    }

    console.error('Failed to mint a Hume access token.', error);
    return Response.json(
      {
        error:
          'The server could not create a Hume access token. Check its credentials and try again.',
      },
      { status: 502, headers: PRIVATE_NO_STORE_HEADERS },
    );
  }
}
