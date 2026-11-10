/* Measurement: Vercel Web Analytics records page views (script loaded in each page's <head>).
   This file adds named events so we can see which buttons get clicked and where leads stop:
   - any element with data-track="name" (and optional data-track-where="hero|nav|...")
   - every Call / Text / Email link, automatically
   - form submissions, via window.dwbTrack('form_sent', {...}) from the page's form code */
(function(){
  window.va = window.va || function(){ (window.vaq = window.vaq || []).push(arguments); };
  function track(name, data){
    try {
      data = data || {};
      data.page = location.pathname.replace(/\.html$/, '').replace(/^\/$/, '/index') || '/index';
      window.va('event', { name: name, data: data });
    } catch (e) {}
  }
  window.dwbTrack = track;
  document.addEventListener('click', function(e){
    var el = e.target.closest && e.target.closest('[data-track], a[href^="tel:"], a[href^="sms:"], a[href^="mailto:"]');
    if (!el) return;
    if (el.dataset.track) return track(el.dataset.track, { where: el.dataset.trackWhere || '' });
    var href = el.getAttribute('href');
    track(href.indexOf('tel:') === 0 ? 'call_click' : href.indexOf('sms:') === 0 ? 'text_click' : 'email_click', {});
  }, true);
})();
