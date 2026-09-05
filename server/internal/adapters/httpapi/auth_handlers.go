package httpapi

import (
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/SingleMai/ATape/server/internal/authentication"
)

type userDTO struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	AvatarURL   string `json:"avatarUrl"`
}

func userResponse(user authentication.User) userDTO {
	return userDTO{ID: user.ID, DisplayName: user.DisplayName, AvatarURL: user.AvatarURL}
}

type beginFederatedRequest struct {
	ProviderRegistrationID string `json:"providerRegistrationId"`
	ReturnTo               string `json:"returnTo"`
}

type beginFederatedResponse struct {
	LoginTransactionID string    `json:"loginTransactionId"`
	AuthorizationURI   string    `json:"authorizationUri"`
	ExpiresAt          time.Time `json:"expiresAt"`
}

func (h *Handler) federatedSignIn(response http.ResponseWriter, request *http.Request) {
	h.beginFederated(response, request, authentication.SignInIntent)
}

func (h *Handler) federatedIdentityBinding(response http.ResponseWriter, request *http.Request) {
	h.beginFederated(response, request, authentication.BindIdentityIntent)
}

func (h *Handler) federatedReauthentication(response http.ResponseWriter, request *http.Request) {
	h.beginFederated(response, request, authentication.ReauthenticateIntent)
}

func (h *Handler) beginFederated(
	response http.ResponseWriter,
	request *http.Request,
	intent authentication.LoginIntent,
) {
	if h.auth == nil {
		writeProblem(response, request, problemServiceUnavailable, 0, nil)
		return
	}
	var input beginFederatedRequest
	if !decodeJSON(response, request, &input) {
		return
	}
	currentSecret := ""
	if intent != authentication.SignInIntent {
		currentSecret = requestAuthenticationFromContext(request.Context()).webSecret
	}
	challenge, err := h.auth.BeginFederatedLogin(request.Context(), authentication.BeginFederatedLoginInput{
		Intent: intent, ProviderRegistrationID: input.ProviderRegistrationID,
		ReturnTo: input.ReturnTo, CurrentWebSessionSecret: currentSecret,
		RequestID: requestIDFromContext(request.Context()),
	})
	if err != nil {
		writeError(response, request, err)
		return
	}
	h.setLoginBindingCookie(response, challenge.BrowserBinding, challenge.ExpiresAt)
	writeJSON(response, request, http.StatusCreated, beginFederatedResponse{
		LoginTransactionID: challenge.LoginTransactionID,
		AuthorizationURI:   challenge.AuthorizationURI, ExpiresAt: challenge.ExpiresAt,
	})
}

func (h *Handler) federatedCallback(providerRegistrationID string) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Referrer-Policy", "no-referrer")
		h.clearLoginBindingCookie(response)
		if h.auth == nil || !validCallbackQuery(request) {
			h.redirectLoginFailure(response, request, "login_failed")
			return
		}
		cookies := request.CookiesNamed(h.config.loginCookie)
		if len(cookies) != 1 || cookies[0].Value == "" {
			h.redirectLoginFailure(response, request, "login_failed")
			return
		}
		query := request.URL.Query()
		grant, err := h.auth.CompleteFederatedLogin(request.Context(), authentication.CompleteFederatedLoginInput{
			ProviderRegistrationID: providerRegistrationID, State: query.Get("state"),
			BrowserBinding: cookies[0].Value, AuthorizationCode: query.Get("code"),
			AuthorizationError: query.Get("error"), RequestID: requestIDFromContext(request.Context()),
		})
		if err != nil {
			h.redirectLoginFailure(response, request, callbackFailureCode(err))
			return
		}
		h.setSessionCookie(response, grant.SessionSecret, grant.Session.AbsoluteExpiresAt)
		response.Header().Set("Location", h.config.webOrigin+grant.ReturnTo)
		response.WriteHeader(http.StatusSeeOther)
	}
}

func validCallbackQuery(request *http.Request) bool {
	if len(request.URL.RawQuery) > 8192 {
		return false
	}
	query := request.URL.Query()
	for key, values := range query {
		if key != "state" && key != "code" && key != "error" {
			return false
		}
		if len(values) != 1 {
			return false
		}
	}
	state := query.Get("state")
	code := query.Get("code")
	providerError := query.Get("error")
	return state != "" && len(state) <= 512 && len(code) <= 4096 && len(providerError) <= 100 &&
		((code != "" && providerError == "") || (code == "" && providerError != ""))
}

func callbackFailureCode(err error) string {
	switch authentication.ErrorCodeOf(err) {
	case authentication.CodeProviderAccessDenied:
		return "access_denied"
	case authentication.CodeLoginExpired:
		return "login_expired"
	case authentication.CodeExternalIdentityConflict:
		return "identity_conflict"
	case authentication.CodeProviderUnavailable, authentication.CodeServiceUnavailable:
		return "provider_unavailable"
	default:
		return "login_failed"
	}
}

func (h *Handler) redirectLoginFailure(response http.ResponseWriter, request *http.Request, code string) {
	location := h.config.webOrigin + "/auth/error?code=" + url.QueryEscape(code) +
		"&incident=" + url.QueryEscape(requestIDFromContext(request.Context()))
	response.Header().Set("Location", location)
	response.WriteHeader(http.StatusSeeOther)
}

type sessionDTO struct {
	User       userDTO       `json:"user"`
	WebSession webSessionDTO `json:"webSession"`
	CSRFToken  string        `json:"csrfToken"`
}

type webSessionDTO struct {
	ID                string    `json:"id"`
	CreatedAt         time.Time `json:"createdAt"`
	LastUsedAt        time.Time `json:"lastUsedAt"`
	ReauthenticatedAt time.Time `json:"reauthenticatedAt"`
	AbsoluteExpiresAt time.Time `json:"absoluteExpiresAt"`
	Current           bool      `json:"current,omitempty"`
}

func (h *Handler) session(response http.ResponseWriter, request *http.Request) {
	authenticated := requestAuthenticationFromContext(request.Context())
	if authenticated.web == nil {
		writeProblem(response, request, problemServiceUnavailable, 0, nil)
		return
	}
	writeJSON(response, request, http.StatusOK, sessionDTO{
		User: userResponse(authenticated.web.User),
		WebSession: webSessionDTO{
			ID: authenticated.web.Session.ID, CreatedAt: authenticated.web.Session.CreatedAt,
			LastUsedAt:        authenticated.web.Session.LastUsedAt,
			ReauthenticatedAt: authenticated.web.Session.ReauthenticatedAt,
			AbsoluteExpiresAt: authenticated.web.Session.AbsoluteExpiresAt,
		},
		CSRFToken: authenticated.web.CSRFToken,
	})
}

func (h *Handler) logout(response http.ResponseWriter, request *http.Request) {
	var empty struct{}
	if !decodeJSON(response, request, &empty) {
		return
	}
	authenticated := requestAuthenticationFromContext(request.Context())
	if h.auth == nil {
		writeProblem(response, request, problemServiceUnavailable, 0, nil)
		return
	}
	if authenticated.principal.WebSessionID != "" {
		err := h.auth.RevokeWebSessions(request.Context(), authentication.RevokeWebSessionsInput{
			Principal: authenticated.principal, SessionID: authenticated.principal.WebSessionID,
			Reason: "logout", RequestID: requestIDFromContext(request.Context()),
		})
		if err != nil {
			writeError(response, request, err)
			return
		}
	}
	h.clearSessionCookie(response)
	writeNoContent(response, http.StatusNoContent)
}

func (h *Handler) currentUser(response http.ResponseWriter, request *http.Request) {
	writeJSON(response, request, http.StatusOK, userResponse(requestAuthenticationFromContext(request.Context()).user))
}

func (h *Handler) updateCurrentUser(response http.ResponseWriter, request *http.Request) {
	var input struct {
		DisplayName string `json:"displayName"`
	}
	if !decodeJSON(response, request, &input) {
		return
	}
	if h.auth == nil {
		writeProblem(response, request, problemServiceUnavailable, 0, nil)
		return
	}
	user, err := h.auth.UpdateUserProfile(request.Context(), authentication.UpdateUserProfileInput{
		Principal:   requestAuthenticationFromContext(request.Context()).principal,
		DisplayName: input.DisplayName, RequestID: requestIDFromContext(request.Context()),
	})
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeJSON(response, request, http.StatusOK, userResponse(user))
}

func (h *Handler) externalIdentities(response http.ResponseWriter, request *http.Request) {
	if h.auth == nil {
		writeProblem(response, request, problemServiceUnavailable, 0, nil)
		return
	}
	identities, err := h.auth.ListExternalIdentities(
		request.Context(), requestAuthenticationFromContext(request.Context()).principal,
	)
	if err != nil {
		writeError(response, request, err)
		return
	}
	type identityDTO struct {
		ID                     string    `json:"id"`
		ProviderRegistrationID string    `json:"providerRegistrationId"`
		DisplayName            string    `json:"displayName"`
		AvatarURL              string    `json:"avatarUrl"`
		CreatedAt              time.Time `json:"createdAt"`
		LastVerifiedAt         time.Time `json:"lastVerifiedAt"`
	}
	items := make([]identityDTO, 0, len(identities))
	for _, identity := range identities {
		items = append(items, identityDTO{
			ID: identity.ID, ProviderRegistrationID: identity.ProviderRegistrationID,
			DisplayName: identity.DisplayName, AvatarURL: identity.AvatarURL,
			CreatedAt: identity.CreatedAt, LastVerifiedAt: identity.LastVerifiedAt,
		})
	}
	writeJSON(response, request, http.StatusOK, struct {
		Items []identityDTO `json:"items"`
	}{Items: items})
}

func (h *Handler) webSessions(response http.ResponseWriter, request *http.Request) {
	if h.auth == nil {
		writeProblem(response, request, problemServiceUnavailable, 0, nil)
		return
	}
	items, err := h.auth.ListWebSessions(request.Context(), requestAuthenticationFromContext(request.Context()).principal)
	if err != nil {
		writeError(response, request, err)
		return
	}
	result := make([]webSessionDTO, 0, len(items))
	for _, item := range items {
		result = append(result, webSessionDTO{
			ID: item.ID, CreatedAt: item.CreatedAt, LastUsedAt: item.LastUsedAt,
			ReauthenticatedAt: item.ReauthenticatedAt, AbsoluteExpiresAt: item.AbsoluteExpiresAt,
			Current: item.Current,
		})
	}
	writeJSON(response, request, http.StatusOK, struct {
		Items []webSessionDTO `json:"items"`
	}{Items: result})
}

func (h *Handler) revokeWebSession(response http.ResponseWriter, request *http.Request) {
	authenticated := requestAuthenticationFromContext(request.Context())
	if h.auth == nil {
		writeProblem(response, request, problemServiceUnavailable, 0, nil)
		return
	}
	sessionID := request.PathValue("sessionId")
	err := h.auth.RevokeWebSessions(request.Context(), authentication.RevokeWebSessionsInput{
		Principal: authenticated.principal, SessionID: sessionID,
		Reason: "user_revoked", RequestID: requestIDFromContext(request.Context()),
	})
	if err != nil {
		writeError(response, request, err)
		return
	}
	if sessionID == authenticated.principal.WebSessionID {
		h.clearSessionCookie(response)
	}
	writeNoContent(response, http.StatusNoContent)
}

func (h *Handler) revokeAllWebSessions(response http.ResponseWriter, request *http.Request) {
	var empty struct{}
	if !decodeJSON(response, request, &empty) {
		return
	}
	if h.auth == nil {
		writeProblem(response, request, problemServiceUnavailable, 0, nil)
		return
	}
	err := h.auth.RevokeWebSessions(request.Context(), authentication.RevokeWebSessionsInput{
		Principal: requestAuthenticationFromContext(request.Context()).principal,
		All:       true, Reason: "user_revoked_all", RequestID: requestIDFromContext(request.Context()),
	})
	if err != nil {
		writeError(response, request, err)
		return
	}
	h.clearSessionCookie(response)
	writeNoContent(response, http.StatusNoContent)
}

type cliCredentialDTO struct {
	ID         string    `json:"id"`
	Capability string    `json:"capability"`
	CreatedAt  time.Time `json:"createdAt"`
	LastUsedAt time.Time `json:"lastUsedAt"`
}

func (h *Handler) cliCredentials(response http.ResponseWriter, request *http.Request) {
	if h.auth == nil {
		writeProblem(response, request, problemServiceUnavailable, 0, nil)
		return
	}
	items, err := h.auth.ListCLICredentials(request.Context(), requestAuthenticationFromContext(request.Context()).principal)
	if err != nil {
		writeError(response, request, err)
		return
	}
	result := make([]cliCredentialDTO, 0, len(items))
	for _, item := range items {
		result = append(result, cliCredentialDTO{
			ID: item.ID, Capability: item.Capability, CreatedAt: item.CreatedAt, LastUsedAt: item.LastUsedAt,
		})
	}
	writeJSON(response, request, http.StatusOK, struct {
		Items []cliCredentialDTO `json:"items"`
	}{Items: result})
}

func (h *Handler) revokeCLICredential(response http.ResponseWriter, request *http.Request) {
	if h.auth == nil {
		writeProblem(response, request, problemServiceUnavailable, 0, nil)
		return
	}
	err := h.auth.RevokeCLICredentials(request.Context(), authentication.RevokeCLICredentialsInput{
		Principal:    requestAuthenticationFromContext(request.Context()).principal,
		CredentialID: request.PathValue("credentialId"), Reason: "user_revoked",
		RequestID: requestIDFromContext(request.Context()),
	})
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeNoContent(response, http.StatusNoContent)
}

func (h *Handler) revokeAllCLICredentials(response http.ResponseWriter, request *http.Request) {
	var empty struct{}
	if !decodeJSON(response, request, &empty) {
		return
	}
	if h.auth == nil {
		writeProblem(response, request, problemServiceUnavailable, 0, nil)
		return
	}
	err := h.auth.RevokeCLICredentials(request.Context(), authentication.RevokeCLICredentialsInput{
		Principal: requestAuthenticationFromContext(request.Context()).principal,
		All:       true, Reason: "user_revoked_all", RequestID: requestIDFromContext(request.Context()),
	})
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeNoContent(response, http.StatusNoContent)
}

func (h *Handler) createCLIDeviceGrant(response http.ResponseWriter, request *http.Request) {
	var empty struct{}
	if !decodeJSON(response, request, &empty) {
		return
	}
	if h.auth == nil {
		writeProblem(response, request, problemServiceUnavailable, 0, nil)
		return
	}
	grant, err := h.auth.CreateCLIDeviceAuthorization(request.Context())
	if err != nil {
		writeError(response, request, err)
		return
	}
	verificationURI := h.config.webOrigin + "/cli/authorize"
	complete, _ := url.Parse(verificationURI)
	query := complete.Query()
	query.Set("user_code", grant.UserCode)
	complete.RawQuery = query.Encode()
	writeJSON(response, request, http.StatusCreated, struct {
		Protocol                string `json:"protocol"`
		DeviceCode              string `json:"device_code"`
		UserCode                string `json:"user_code"`
		VerificationURI         string `json:"verification_uri"`
		VerificationURIComplete string `json:"verification_uri_complete"`
		ExpiresIn               int    `json:"expires_in"`
		Interval                int    `json:"interval"`
	}{
		Protocol: "atape.cli-authorization.v1", DeviceCode: grant.DeviceCode,
		UserCode: grant.UserCode, VerificationURI: verificationURI,
		VerificationURIComplete: complete.String(), ExpiresIn: positiveSecondsUntil(grant.ExpiresAt),
		Interval: grant.PollIntervalSeconds,
	})
}

func (h *Handler) pollCLIDeviceGrant(response http.ResponseWriter, request *http.Request) {
	var input struct {
		DeviceCode string `json:"device_code"`
	}
	if !decodeJSON(response, request, &input) {
		return
	}
	if h.auth == nil {
		writeProblem(response, request, problemServiceUnavailable, 0, nil)
		return
	}
	grant, err := h.auth.PollCLIDeviceAuthorization(
		request.Context(), input.DeviceCode, requestIDFromContext(request.Context()),
	)
	if err != nil {
		var typed *authentication.Error
		if errors.As(err, &typed) && typed.Code == authentication.CodeAuthorizationPending {
			response.Header().Set("Retry-After", strconv.Itoa(typed.RetryAfter))
			writeJSON(response, request, http.StatusAccepted, struct {
				Status     string `json:"status"`
				RetryAfter int    `json:"retry_after"`
			}{Status: "authorization_pending", RetryAfter: typed.RetryAfter})
			return
		}
		writeError(response, request, err)
		return
	}
	writeJSON(response, request, http.StatusOK, struct {
		TokenType    string    `json:"token_type"`
		Credential   string    `json:"credential"`
		CredentialID string    `json:"credential_id"`
		Capability   string    `json:"capability_version"`
		CreatedAt    time.Time `json:"created_at"`
		User         struct {
			ID          string `json:"id"`
			DisplayName string `json:"display_name"`
		} `json:"user"`
	}{
		TokenType: "Bearer", Credential: grant.CredentialSecret,
		CredentialID: grant.CredentialID, Capability: grant.Capability,
		CreatedAt: grant.CreatedAt, User: struct {
			ID          string `json:"id"`
			DisplayName string `json:"display_name"`
		}{ID: grant.User.ID, DisplayName: grant.User.DisplayName},
	})
}

func (h *Handler) resolveCLIDeviceGrant(response http.ResponseWriter, request *http.Request) {
	var input struct {
		UserCode string `json:"user_code"`
	}
	if !decodeJSON(response, request, &input) {
		return
	}
	if h.auth == nil {
		writeProblem(response, request, problemServiceUnavailable, 0, nil)
		return
	}
	view, err := h.auth.ResolveCLIDeviceAuthorization(
		request.Context(), requestAuthenticationFromContext(request.Context()).principal,
		input.UserCode, requestIDFromContext(request.Context()),
	)
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeJSON(response, request, http.StatusOK, struct {
		GrantViewID       string    `json:"grantViewId"`
		UserCode          string    `json:"userCode"`
		InstanceOrigin    string    `json:"instanceOrigin"`
		ClientLabel       string    `json:"clientLabel"`
		Capability        string    `json:"capabilityVersion"`
		PermissionSummary string    `json:"permissionSummary"`
		ExpiresAt         time.Time `json:"expiresAt"`
		Status            string    `json:"status"`
	}{
		GrantViewID: view.ID, UserCode: view.UserCode, InstanceOrigin: h.config.instanceOrigin,
		ClientLabel: view.ClientLabel, Capability: view.Capability,
		PermissionSummary: "Read and sync this account's ATape projects.",
		ExpiresAt:         view.ExpiresAt, Status: view.Status,
	})
}

func (h *Handler) approveCLIDeviceGrant(response http.ResponseWriter, request *http.Request) {
	h.decideCLIDeviceGrant(response, request, authentication.ApproveCLI)
}

func (h *Handler) denyCLIDeviceGrant(response http.ResponseWriter, request *http.Request) {
	h.decideCLIDeviceGrant(response, request, authentication.DenyCLI)
}

func (h *Handler) decideCLIDeviceGrant(
	response http.ResponseWriter,
	request *http.Request,
	decision authentication.CLIDecision,
) {
	var empty struct{}
	if !decodeJSON(response, request, &empty) {
		return
	}
	if h.auth == nil {
		writeProblem(response, request, problemServiceUnavailable, 0, nil)
		return
	}
	err := h.auth.DecideCLIDeviceAuthorization(
		request.Context(), requestAuthenticationFromContext(request.Context()).principal,
		request.PathValue("grantViewId"), decision, requestIDFromContext(request.Context()),
	)
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeNoContent(response, http.StatusNoContent)
}

func (h *Handler) revokeCurrentCLICredential(response http.ResponseWriter, request *http.Request) {
	if h.auth == nil {
		writeProblem(response, request, problemServiceUnavailable, 0, nil)
		return
	}
	err := h.auth.RevokeCurrentCLICredential(
		request.Context(), requestAuthenticationFromContext(request.Context()).cliSecret,
		requestIDFromContext(request.Context()),
	)
	if err != nil {
		writeError(response, request, err)
		return
	}
	writeNoContent(response, http.StatusNoContent)
}

func positiveSecondsUntil(deadline time.Time) int {
	duration := time.Until(deadline)
	seconds := int(duration / time.Second)
	if duration%time.Second != 0 {
		seconds++
	}
	if seconds < 1 {
		return 1
	}
	return seconds
}
