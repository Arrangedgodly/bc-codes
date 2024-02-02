export type RedeemedProps = {
  releaseId: string;
  code: string;
}

export type UserProps = {
  uid: string;
  name: string;
  accountType: "Fan" | "Artist" | "Both";
}

export type ArtistProps = {
  uid: string;
  name: string;
  location: string;
  releases: ReleaseProps[];
  followers: FanProps[];
};

export type FanProps = {
  uid: string;
  name: string;
  redeemed: RedeemedProps[];
  following: ArtistProps[];
}

export type AvatarProps = {
  user: any;
  handleLogout: () => void;
};

export type ReleaseProps = {
  id: string;
  name: string;
  about: string;
  artist: string;
  codes: string[];
  image: string;
  link: string;
  releaseDate: string;
  releaseType: string;
};

export type NewReleaseProps = {
  name: string;
  about: string;
  artist: string;
  codes: string[];
  image: string;
  link: string;
  releaseDate: string;
  releaseType: string;
}
