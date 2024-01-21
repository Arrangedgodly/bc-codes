export type RedeemedProps = {
  releaseId: string;
  code: string;
}

export type ArtistProps = {
  uid: string;
  name: string;
  location: string;
  releases: ReleaseProps[];
  redeemed: RedeemedProps[];
};

export type AvatarProps = {
  user: any;
  handleLogout: () => void;
};

export type ReleaseProps = {
  name: string;
  about: string;
  artist: string;
  codes: string[];
  image: string;
  link: string;
  releaseDate: string;
  releaseType: string;
};
