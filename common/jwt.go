package common

import (
	"github.com/dgrijalva/jwt-go"
	"github.com/housepower/ckman/model"
)

// signingKey signs login tokens. The fixed default is only a fallback: the
// server loads the installation's random key at start (session.LoadSigningKey).
var signingKey = []byte("change me")

// SetSigningKey sets the key that signs and checks login tokens.
func SetSigningKey(key []byte) { signingKey = key }

type JWT struct {
	SigningKey []byte
}

func NewJWT() *JWT {
	return &JWT{signingKey}
}

type CustomClaims struct {
	jwt.StandardClaims
	Name     string `json:"name"`
	ClientIP string `json:"clientIp"`
}

func (j *JWT) CreateToken(claims CustomClaims) (string, error) {
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(j.SigningKey)
}

func (j *JWT) ParserToken(tokenString string) (*CustomClaims, string) {
	token, err := jwt.ParseWithClaims(tokenString, &CustomClaims{}, func(token *jwt.Token) (interface{}, error) {
		return j.SigningKey, nil
	})

	if _, ok := err.(*jwt.ValidationError); ok {
		return nil, model.E_JWT_TOKEN_INVALID
	}

	if claims, ok := token.Claims.(*CustomClaims); ok && token.Valid {
		return claims, model.E_SUCCESS
	} else {
		return nil, model.E_JWT_TOKEN_INVALID
	}
}
