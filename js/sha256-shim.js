  // js-sha256 (a selector dependency) mistakes esm.sh's process shim for Node and calls require().
  window.JS_SHA256_NO_NODE_JS = true; window.JS_SHA256_NO_COMMON_JS = true;
