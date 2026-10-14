import {NEUTRAL_BRAND_NAME} from '@plunk/shared';
import {Head, Html, Main, NextScript} from 'next/document';

function Document({locale}: {locale: string}) {
  return (
    <Html lang={locale}>
      <Head>
        {/* Viewport */}
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0" />

        {/* Primary Meta Tags */}
        <meta name="title" content={NEUTRAL_BRAND_NAME} />
        <meta name="description" content="Manage your email campaigns, contacts, and analytics." />

        {/* Open Graph / Facebook */}
        <meta property="og:type" content="website" />
        <meta property="og:title" content={NEUTRAL_BRAND_NAME} />
        <meta property="og:description" content="Manage your email campaigns, contacts, and analytics." />

        {/* Twitter */}
        <meta property="twitter:card" content="summary" />
        <meta property="twitter:title" content={NEUTRAL_BRAND_NAME} />
        <meta property="twitter:description" content="Manage your email campaigns, contacts, and analytics." />

        {/* Fonts */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@100;200;300;400;500;600;700;800;900&display=swap"
          rel="stylesheet"
        />

        {/* Favicon and app name are per project, set in _app's BrandHead */}
        <meta name="theme-color" content="#ffffff" />
      </Head>
      <body className="antialiased cursor-default scroll-smooth text-neutral-800">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}

export default Document;
