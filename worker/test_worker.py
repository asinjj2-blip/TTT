from main import clean_username, valid_username, profile_from_payload


def test_username_validation():
    assert clean_username('@demo.user') == 'demo.user'
    assert valid_username('demo.user')
    assert not valid_username('bad username!')


def test_profile_normalization_and_explicit_region():
    raw = {
        'userInfo': {
            'user': {
                'id': '123',
                'secUid': 'sec123',
                'uniqueId': 'demo',
                'nickname': 'Demo User',
                'signature': 'hello',
                'verified': False,
                'privateAccount': False,
                'region': 'US',
                'language': 'en',
                'createTime': 1700000000,
            },
            'stats': {
                'followerCount': 100,
                'followingCount': 20,
                'heartCount': 500,
                'videoCount': 10,
            },
        }
    }
    profile = profile_from_payload('demo', raw)
    assert profile['username'] == 'demo'
    assert profile['displayName'] == 'Demo User'
    assert profile['regionCode'] == 'US'
    assert profile['regionSource'] == 'Explicit TikTok profile field: user.region'
    assert profile['followerCount'] == 100
    assert profile['userId'] == '123'


def test_does_not_infer_region_from_bio_or_language():
    raw = {
        'userInfo': {
            'user': {
                'id': '123',
                'uniqueId': 'demo',
                'nickname': 'Demo User',
                'signature': 'USA based creator 🇺🇸',
                'language': 'en-US',
            },
            'stats': {},
        }
    }
    profile = profile_from_payload('demo', raw)
    assert profile['regionCode'] is None
    assert profile['regionSource'] is None
