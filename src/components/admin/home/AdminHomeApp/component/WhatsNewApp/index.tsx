import React from 'react';
import {formatAdminDateTime} from "@/client/admin-date-format";
import i18n from "@/client/i18n";
import {OUR_BRAND} from "@/shared/Constants";

const FETCH_STATUS__START = 1;

export default class WhatsNewApp extends React.Component<any, any> {
  constructor(props: any) {
    super(props);

    this.state = {
      items: [],
      fetchStatus: FETCH_STATUS__START,
    };
  }

  componentDidMount() {
    const endpoint = OUR_BRAND.whatsnewEndpoint;

    this.setState({fetchStatus: FETCH_STATUS__START});
    fetch(endpoint).then((d: any) => d.json()).then((d: any) => {
      this.setState({
        items: d.items.slice(0, 5),
        fetchStatus: null,
      })
    }).catch(() => {
      this.setState({fetchStatus: null});
    });
  }

  render() {
    const t = i18n.t.bind(i18n);
    const {items, fetchStatus} = this.state;
    const fetching = fetchStatus === FETCH_STATUS__START;
    return (<div className="rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs">
      <div className="mb-4 text-lg font-semibold tracking-tight">
        {t('home.whatsNewTitle', {domain: OUR_BRAND.domain})}
      </div>
      <div>
        {fetching ? <div className="text-muted-color text-sm">
          {t('home.loading')}
        </div> : <div className="grid grid-cols-1 gap-4">
          {items.map((item: any) => (<div key={`item-${item.id}`}>
            <div>
              <a className="font-normal" href={item._microfeed.web_url} target="_blank" rel="noopener noreferrer">{item.title}</a>
            </div>
            <div className="text-xs text-muted-color mt-1">
              {/* Canonical admin date format, built from the raw ms / ISO only.
                  The feed also ships `_microfeed.date_published_short`, but that
                  string is pre-formatted in the *publisher's* timezone and lands
                  on a different calendar day than the raw fields (measured:
                  `2026-09-22T20:19:19.650Z` → `"Wed Sep 23 2026"`), so running it
                  through the formatter printed a confidently wrong time. It is
                  also never reached: all 14 items in the live feed carry both
                  raw fields. If the feed ever drops them the cell renders empty
                  rather than a fabricated midnight. */}
              {formatAdminDateTime(item._microfeed.date_published_ms ?? item.date_published)}
            </div>
          </div>))}
          {items.length > 0 ? <div className="text-right">
            <a href={`${OUR_BRAND.whatsnewWebsite}/#whats-new`} target="_blank">{t('home.readMore')} <span className="lh-icon-arrow-right" /></a>
          </div> : <div className="-text-xs text-muted-color mt-1">
            {t('home.noNews')}
          </div>}
        </div>}
      </div>
    </div>);
  }
}
