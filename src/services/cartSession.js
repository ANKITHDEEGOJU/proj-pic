'use strict';
// The cart code keeps the applied coupon in `req.session.couponCode`, but the app has no
// session store, so the coupon was forgotten on every page load. This small middleware backs
// that one field with an httpOnly cookie. The code is re-validated on every use, so a
// tampered cookie cannot grant a discount the user is not eligible for.
const COOKIE = 'cart_coupon';
const OPTS = { httpOnly: true, sameSite: 'lax', maxAge: 7 * 86400e3 };

module.exports = function cartSession(req, res, next) {
  const data = { couponCode: req.cookies?.[COOKIE] || undefined };
  req.session = new Proxy(data, {
    get(target, key) {
      if (key === 'save') return (cb) => cb && cb();
      return target[key];
    },
    set(target, key, value) {
      target[key] = value;
      if (key === 'couponCode' && !res.headersSent) res.cookie(COOKIE, String(value), OPTS);
      return true;
    },
    deleteProperty(target, key) {
      delete target[key];
      if (key === 'couponCode' && !res.headersSent) res.clearCookie(COOKIE, OPTS);
      return true;
    },
  });
  next();
};
