export const redactEndpointUserInfo = (endpoint: string): string => {
  try {
    const url = new URL(endpoint);
    if (!url.username && !url.password) return endpoint;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return endpoint.replace(
      /^([a-z][a-z0-9+.-]*:\/\/)(?:[^/?#@]*@)/i,
      "$1",
    );
  }
};
