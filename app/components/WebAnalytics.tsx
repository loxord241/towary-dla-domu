'use client';

import Script from 'next/script';

/**
 * GA4 + Microsoft Clarity loaders (owner task 2026-09-13, «пакет А»).
 *
 * Both are gated on PUBLIC env vars — no IDs, no requests, no DOM impact
 * when unset. IDs live in Vercel env (NEXT_PUBLIC_GA4_ID, G-… format;
 * NEXT_PUBLIC_CLARITY_ID) and are added per deployment by the owner.
 *
 * Vercel Analytics stays as-is; this component adds the measurement layer
 * the audit found missing (traffic sources, funnels, session recordings).
 */

export default function WebAnalytics() {
  const gaId = process.env.NEXT_PUBLIC_GA4_ID?.trim();
  const clarityId = process.env.NEXT_PUBLIC_CLARITY_ID?.trim();

  return (
    <>
      {gaId && (
        <>
          <Script
            src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`}
            strategy="afterInteractive"
          />
          <Script id="ga4-init" strategy="afterInteractive">
            {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${gaId}', { anonymize_ip: true });`}
          </Script>
        </>
      )}
      {clarityId && (
        <Script id="clarity-init" strategy="afterInteractive">
          {`(function(c,l,a,r,i,t,y){
c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
})(window, document, "clarity", "script", "${clarityId}");`}
        </Script>
      )}
    </>
  );
}
