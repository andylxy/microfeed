import React from 'react';
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
              {item._microfeed.date_published_short}
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
