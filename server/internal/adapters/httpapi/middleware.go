package httpapi

import (
	"crypto/subtle"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/SingleMai/ATape/server/internal/authcutover"
	"github.com/SingleMai/ATape/server/internal/authentication"
)

func (h *Handler) dispatch(registered route) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		request = request.WithContext(withRequestBodyPolicy(request.Context(), registered.body))
		switch registered.cache {
		case noStore:
			setNoStore(response.Header())
		case publicMetadata:
			response.Header().Set("Cache-Control", "public, max-age=300")
		}
		if registered.pragmaNoCache {
			response.Header().Set("Pragma", "no-cache")
		}
		if h.config.cutoverMode == authcutover.BootstrapMode && !registered.bootstrapAllowed {
			writeProblem(response, request, problemCutoverIncomplete, 0, nil)
			return
		}
		if registered.requireOrigin && !h.hasExactWebOrigin(request) {
			writeProblem(response, request, problemOriginRejected, 0, nil)
			return
		}
		if registered.Class == PublicProtocol {
			serveRegisteredRoute(response, request, registered)
			return
		}
		if isUnsafeMethod(request.Method) && registered.Class == WebOnly && !h.hasExactWebOrigin(request) {
			writeProblem(response, request, problemOriginRejected, 0, nil)
			return
		}
		if registered.cliProofOnly {
			credentials, problem := readCredentials(request, h.config.sessionCookie)
			if problem != "" {
				writeProblem(response, request, problem, 0, nil)
				return
			}
			if credentials.hasCookie || !credentials.hasAuthorization || !credentials.validBearer {
				h.setAuthenticationChallenge(response.Header(), registered.Class, nil)
				writeProblem(response, request, problemUnauthenticated, 0, nil)
				return
			}
			request = request.WithContext(withRequestAuthentication(request.Context(), requestAuthentication{
				cliSecret: credentials.bearer,
			}))
			serveRegisteredRoute(response, request, registered)
			return
		}

		authenticated, directProblem, err := h.authenticate(request, registered)
		if directProblem != "" {
			writeProblem(response, request, directProblem, 0, nil)
			return
		}
		if err != nil {
			if registered.idempotentWebLogout && canClearFailedWebLogout(request, h.config.sessionCookie, err) {
				request = request.WithContext(withRequestAuthentication(request.Context(), requestAuthentication{}))
				registered.handler(response, request)
				return
			}
			h.setAuthenticationChallenge(response.Header(), registered.Class, err)
			writeError(response, request, err)
			return
		}
		if isUnsafeMethod(request.Method) && authenticated.principal.Method == authentication.WebAuthentication {
			if !h.hasExactWebOrigin(request) {
				writeProblem(response, request, problemOriginRejected, 0, nil)
				return
			}
			if authenticated.web == nil || !validCSRFHeader(request, authenticated.web.CSRFToken) {
				writeProblem(response, request, problemCSRFRejected, 0, nil)
				return
			}
		}
		if registered.requiresIdempotency && !hasSingleIdempotencyKey(request) {
			writeProblem(response, request, problemInvalidRequest, 0, nil)
			return
		}
		request = request.WithContext(withRequestAuthentication(request.Context(), authenticated))
		serveRegisteredRoute(response, request, registered)
	})
}

func serveRegisteredRoute(response http.ResponseWriter, request *http.Request, registered route) {
	if registered.body == noRequestBody &&
		(request.ContentLength != 0 || len(request.TransferEncoding) != 0) {
		writeProblem(response, request, problemInvalidRequest, 0, nil)
		return
	}
	registered.handler(response, request)
}

func hasSingleIdempotencyKey(request *http.Request) bool {
	values := request.Header.Values("Idempotency-Key")
	return len(values) == 1 && values[0] != "" && strings.TrimSpace(values[0]) == values[0]
}

func canClearFailedWebLogout(request *http.Request, sessionCookie string, err error) bool {
	credentials, problem := readCredentials(request, sessionCookie)
	if problem != "" || credentials.hasAuthorization {
		return false
	}
	switch authentication.ErrorCodeOf(err) {
	case authentication.CodeUnauthenticated, authentication.CodeSessionRevoked,
		authentication.CodeSessionIdleExpired, authentication.CodeSessionAbsoluteExpired,
		authentication.CodeUserDisabled:
		return true
	default:
		return false
	}
}

func (h *Handler) authenticate(request *http.Request, registered route) (requestAuthentication, problemCode, error) {
	if h.config.development != nil {
		principal := *h.config.development
		switch registered.Class {
		case WebOnly:
			principal.Method = authentication.WebAuthentication
		case CLIOnly:
			principal.Method = authentication.CLIAuthentication
		}
		principal.Fresh = registered.fresh || principal.Fresh
		return requestAuthentication{
			principal: principal,
			user:      authentication.User{ID: principal.UserID, DisplayName: "ATape Demo"},
		}, "", nil
	}

	credentials, problem := readCredentials(request, h.config.sessionCookie)
	if problem != "" {
		return requestAuthentication{}, problem, nil
	}
	if credentials.hasCookie && credentials.hasAuthorization {
		return requestAuthentication{}, problemAmbiguousCredentials, nil
	}
	switch registered.Class {
	case WebOnly:
		if !credentials.hasCookie || credentials.hasAuthorization {
			return requestAuthentication{}, "", &authentication.Error{Code: authentication.CodeUnauthenticated}
		}
		return h.authenticateWeb(request, credentials.cookie, registered.fresh)
	case CLIOnly:
		if credentials.hasCookie || !credentials.hasAuthorization || !credentials.validBearer {
			return requestAuthentication{}, "", &authentication.Error{Code: authentication.CodeUnauthenticated}
		}
		return h.authenticateCLI(request, credentials.bearer)
	case AnyPrincipal:
		switch {
		case credentials.hasCookie:
			return h.authenticateWeb(request, credentials.cookie, registered.fresh)
		case credentials.hasAuthorization && credentials.validBearer:
			return h.authenticateCLI(request, credentials.bearer)
		default:
			return requestAuthentication{}, "", &authentication.Error{Code: authentication.CodeUnauthenticated}
		}
	default:
		return requestAuthentication{}, "", &authentication.Error{Code: authentication.CodeMisconfigured}
	}
}

func (h *Handler) authenticateWeb(
	request *http.Request,
	secret string,
	fresh bool,
) (requestAuthentication, problemCode, error) {
	var result authentication.AuthenticatedWebSession
	var err error
	if fresh {
		result, err = h.auth.AuthenticateFreshWeb(request.Context(), secret)
	} else {
		result, err = h.auth.AuthenticateWeb(request.Context(), secret)
	}
	if err != nil {
		return requestAuthentication{}, "", err
	}
	return requestAuthentication{
		principal: result.Principal, user: result.User, web: &result, webSecret: secret,
	}, "", nil
}

func (h *Handler) authenticateCLI(
	request *http.Request,
	secret string,
) (requestAuthentication, problemCode, error) {
	result, err := h.auth.AuthenticateCLI(request.Context(), secret)
	if err != nil {
		return requestAuthentication{}, "", err
	}
	return requestAuthentication{
		principal: result.Principal, user: result.User, cli: &result, cliSecret: secret,
	}, "", nil
}

type credentialSet struct {
	hasCookie        bool
	cookie           string
	hasAuthorization bool
	validBearer      bool
	bearer           string
}

func readCredentials(request *http.Request, sessionCookie string) (credentialSet, problemCode) {
	result := credentialSet{}
	cookies := request.CookiesNamed(sessionCookie)
	if len(cookies) > 1 {
		return credentialSet{}, problemAmbiguousCredentials
	}
	if len(cookies) == 1 {
		result.hasCookie = true
		result.cookie = cookies[0].Value
	}
	authorization := request.Header.Values("Authorization")
	if len(authorization) > 1 {
		return credentialSet{}, problemAmbiguousCredentials
	}
	if len(authorization) == 1 {
		result.hasAuthorization = true
		scheme, value, found := strings.Cut(authorization[0], " ")
		if found && strings.EqualFold(scheme, "Bearer") && value != "" &&
			strings.TrimSpace(value) == value {
			result.validBearer = true
			result.bearer = value
		}
	}
	return result, ""
}

func (h *Handler) setAuthenticationChallenge(header http.Header, class RouteClass, err error) {
	fresh := authentication.ErrorCodeOf(err) == authentication.CodeFreshAuthenticationRequired
	switch class {
	case WebOnly:
		value := `ATapeSession realm="atape"`
		if fresh {
			value += `, error="fresh_authentication_required"`
		}
		header.Set("WWW-Authenticate", value)
	case CLIOnly:
		header.Set("WWW-Authenticate", `Bearer realm="atape"`)
	case AnyPrincipal:
		header.Add("WWW-Authenticate", `ATapeSession realm="atape"`)
		header.Add("WWW-Authenticate", `Bearer realm="atape"`)
	}
}

func isUnsafeMethod(method string) bool {
	return method != http.MethodGet && method != http.MethodHead && method != http.MethodOptions
}

func (h *Handler) hasExactWebOrigin(request *http.Request) bool {
	values := request.Header.Values("Origin")
	return len(values) == 1 && values[0] == h.config.webOrigin
}

func validCSRFHeader(request *http.Request, expected string) bool {
	values := request.Header.Values("X-ATape-CSRF")
	if len(values) != 1 || expected == "" || len(values[0]) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(values[0]), []byte(expected)) == 1
}

func (h *Handler) applyActualCORS(header http.Header, request *http.Request) {
	if !h.config.splitOrigin {
		return
	}
	appendVary(header, "Origin")
	if !h.hasExactWebOrigin(request) {
		return
	}
	header.Set("Access-Control-Allow-Origin", h.config.webOrigin)
	header.Set("Access-Control-Allow-Credentials", "true")
	header.Set("Access-Control-Expose-Headers", "ETag, Retry-After, X-Request-ID")
}

func (h *Handler) preflight(response http.ResponseWriter, request *http.Request) {
	setNoStore(response.Header())
	appendVary(response.Header(), "Origin")
	appendVary(response.Header(), "Access-Control-Request-Method")
	appendVary(response.Header(), "Access-Control-Request-Headers")
	if !h.hasExactWebOrigin(request) {
		writeProblem(response, request, problemOriginRejected, 0, nil)
		return
	}
	methodValues := request.Header.Values("Access-Control-Request-Method")
	if len(methodValues) != 1 {
		writeProblem(response, request, problemInvalidRequest, 0, nil)
		return
	}
	method := strings.ToUpper(strings.TrimSpace(methodValues[0]))
	probe := request.Clone(request.Context())
	probe.Method = method
	_, pattern := h.mux.Handler(probe)
	if pattern == "" || pattern == "/" {
		writeProblem(response, request, problemNotFound, 0, nil)
		return
	}
	if h.config.cutoverMode == authcutover.BootstrapMode && !h.bootstrapRouteAllowed(method, pattern) {
		writeProblem(response, request, problemCutoverIncomplete, 0, nil)
		return
	}
	headers, ok := allowedPreflightHeaders(request.Header.Values("Access-Control-Request-Headers"))
	if !ok {
		writeProblem(response, request, problemOriginRejected, 0, nil)
		return
	}
	if h.config.splitOrigin {
		response.Header().Set("Access-Control-Allow-Origin", h.config.webOrigin)
		response.Header().Set("Access-Control-Allow-Credentials", "true")
		response.Header().Set("Access-Control-Allow-Methods", method)
		if len(headers) > 0 {
			response.Header().Set("Access-Control-Allow-Headers", strings.Join(headers, ", "))
		}
		response.Header().Set("Access-Control-Max-Age", "600")
	}
	response.WriteHeader(http.StatusNoContent)
}

func (h *Handler) bootstrapRouteAllowed(method string, pattern string) bool {
	for _, registered := range h.routes {
		if registered.Method == method && registered.Pattern == pattern {
			return registered.bootstrapAllowed
		}
	}
	return false
}

func allowedPreflightHeaders(values []string) ([]string, bool) {
	allowed := map[string]string{
		"content-type":    "Content-Type",
		"x-atape-csrf":    "X-ATape-CSRF",
		"idempotency-key": "Idempotency-Key",
	}
	result := make(map[string]string)
	for _, value := range values {
		for _, item := range strings.Split(value, ",") {
			item = strings.ToLower(strings.TrimSpace(item))
			if item == "" {
				continue
			}
			canonical, ok := allowed[item]
			if !ok {
				return nil, false
			}
			result[item] = canonical
		}
	}
	keys := make([]string, 0, len(result))
	for key := range result {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	formatted := make([]string, 0, len(keys))
	for _, key := range keys {
		formatted = append(formatted, result[key])
	}
	return formatted, true
}

func (h *Handler) setLoginBindingCookie(response http.ResponseWriter, value string, expiresAt time.Time) {
	http.SetCookie(response, &http.Cookie{
		Name: h.config.loginCookie, Value: value, Path: "/", HttpOnly: true,
		Secure: h.config.secureCookies, SameSite: http.SameSiteLaxMode,
		Expires: expiresAt, MaxAge: positiveCookieSeconds(expiresAt),
	})
}

func (h *Handler) clearLoginBindingCookie(response http.ResponseWriter) {
	http.SetCookie(response, &http.Cookie{
		Name: h.config.loginCookie, Path: "/", HttpOnly: true,
		Secure: h.config.secureCookies, SameSite: http.SameSiteLaxMode,
		Expires: time.Unix(1, 0).UTC(), MaxAge: -1,
	})
}

func (h *Handler) setSessionCookie(response http.ResponseWriter, value string, expiresAt time.Time) {
	http.SetCookie(response, &http.Cookie{
		Name: h.config.sessionCookie, Value: value, Path: "/", Domain: h.config.cookieDomain,
		HttpOnly: true, Secure: h.config.secureCookies, SameSite: http.SameSiteLaxMode,
		Expires: expiresAt, MaxAge: positiveCookieSeconds(expiresAt),
	})
}

func (h *Handler) clearSessionCookie(response http.ResponseWriter) {
	http.SetCookie(response, &http.Cookie{
		Name: h.config.sessionCookie, Path: "/", Domain: h.config.cookieDomain,
		HttpOnly: true, Secure: h.config.secureCookies, SameSite: http.SameSiteLaxMode,
		Expires: time.Unix(1, 0).UTC(), MaxAge: -1,
	})
}

func positiveCookieSeconds(expiresAt time.Time) int {
	duration := time.Until(expiresAt)
	seconds := int(duration / time.Second)
	if duration%time.Second != 0 {
		seconds++
	}
	if seconds < 1 {
		return 1
	}
	return seconds
}
